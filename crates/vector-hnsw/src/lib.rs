//! Pure-Rust HNSW fallback index.
//!
//! Deliberately small and dependency-free: it exists so WeiSQL can offer an ANN
//! path without USearch, and so recall/latency comparisons have a second,
//! inspectable implementation. It is **not** the default engine and does not
//! promise production-grade recall; `search` reports approximate results and
//! callers must surface that.
//!
//! The implementation follows the usual HNSW shape:
//!
//! - every node gets a random level, so upper layers form sparse shortcuts;
//! - insertion descends greedily from the top layer, then runs `ef_construction`
//!   beam search on each layer the node belongs to;
//! - neighbours are chosen with the diversity heuristic (a candidate is kept
//!   only if it is closer to the query than to every already-kept neighbour);
//! - layer 0 allows `2 × m` links, upper layers `m`.
//!
//! Vectors are `f32`, distances are `f64` and every metric comes from
//! [`weisql_vector_benchmark`], so results line up with the exact baseline and
//! the WASM artifact.

use std::cmp::{Ordering, Reverse};
use std::collections::{BinaryHeap, HashSet};
use std::fmt;

use weisql_vector_benchmark::{distance, Hit, Metric, SearchError};

/// Hard cap on the random level, so a pathological RNG draw cannot blow up.
pub const MAX_LEVEL: usize = 32;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HnswError {
    InvalidConfig(&'static str),
    InvalidQuery(&'static str),
    /// A serialized index failed validation.
    Corrupt(&'static str),
    Build(SearchError),
}

impl HnswError {
    #[must_use]
    pub fn code(&self) -> &'static str {
        match self {
            Self::InvalidConfig(_) => "INVALID_ARGUMENT",
            Self::InvalidQuery(_) => "VECTOR_INVALID_VALUE",
            Self::Corrupt(_) => "RESOURCE_INTEGRITY_FAILED",
            Self::Build(_) => "VECTOR_INVALID_VALUE",
        }
    }
}

impl fmt::Display for HnswError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidConfig(message) => write!(f, "invalid HNSW configuration: {message}"),
            Self::InvalidQuery(message) => write!(f, "invalid HNSW query: {message}"),
            Self::Corrupt(message) => write!(f, "corrupt HNSW index: {message}"),
            Self::Build(error) => write!(f, "invalid HNSW dataset: {error}"),
        }
    }
}

impl std::error::Error for HnswError {}

impl From<SearchError> for HnswError {
    fn from(error: SearchError) -> Self {
        Self::Build(error)
    }
}

/// Construction and search parameters.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct HnswConfig {
    /// Links per node on layers above zero; layer zero keeps `2 × m`.
    pub m: usize,
    /// Beam width while inserting a node.
    pub ef_construction: usize,
    /// Beam width while searching; raised to `top_k` when smaller.
    pub ef_search: usize,
    /// Seed for level assignment, so builds are reproducible.
    pub seed: u64,
}

impl Default for HnswConfig {
    fn default() -> Self {
        Self { m: 16, ef_construction: 200, ef_search: 64, seed: 0x5eed_5eed }
    }
}

/// An immutable HNSW graph over a fixed vector set.
pub struct HnswIndex {
    dimension: usize,
    metric: Metric,
    vectors: Vec<Vec<f32>>,
    levels: Vec<usize>,
    /// `links[node][layer]` holds neighbour ids; layers above `levels[node]` are absent.
    links: Vec<Vec<Vec<u32>>>,
    entry: u32,
    max_level: usize,
    m: usize,
    m0: usize,
    ef_construction: usize,
    ef_search: usize,
    rng: Rng,
    level_multiplier: f64,
}

impl HnswIndex {
    /// Builds the graph. The dataset is validated like the exact baseline:
    /// consistent dimensions, finite values, and no zero vectors for cosine.
    pub fn build(vectors: Vec<Vec<f32>>, metric: Metric, config: HnswConfig) -> Result<Self, HnswError> {
        let dimension = validate_dataset(&vectors, metric)?;
        validate_config(config)?;
        if vectors.len() > u32::MAX as usize {
            return Err(HnswError::InvalidConfig("dataset is too large for 32-bit node ids"));
        }
        let count = vectors.len();
        let m0 = config.m.saturating_mul(2);
        let level_multiplier = 1.0 / (config.m as f64).ln();
        let mut index = Self {
            dimension,
            metric,
            vectors,
            levels: vec![0; count],
            links: vec![Vec::new(); count],
            entry: 0,
            max_level: 0,
            m: config.m,
            m0,
            ef_construction: config.ef_construction,
            ef_search: config.ef_search,
            rng: Rng::new(config.seed),
            level_multiplier,
        };
        index.insert_all(count);
        Ok(index)
    }

    #[must_use]
    pub fn len(&self) -> usize {
        self.vectors.len()
    }

    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.vectors.is_empty()
    }

    #[must_use]
    pub fn dimension(&self) -> usize {
        self.dimension
    }

    #[must_use]
    pub fn metric(&self) -> Metric {
        self.metric
    }

    /// Approximate Top-K search. Results are sorted by ascending distance with
    /// ties broken by row id, and are **not** guaranteed to equal the exact
    /// answer; callers must report `exact: false`.
    pub fn search(&self, query: &[f32], top_k: usize) -> Result<Vec<Hit>, HnswError> {
        if top_k == 0 {
            return Err(HnswError::InvalidQuery("top_k must be greater than zero"));
        }
        if query.len() != self.dimension {
            return Err(HnswError::InvalidQuery("query dimension does not match the index"));
        }
        if !query.iter().all(|value| value.is_finite()) {
            return Err(HnswError::InvalidQuery("query contains a non-finite value"));
        }
        if distance(query, &self.vectors[0], self.metric).is_none() {
            return Err(HnswError::InvalidQuery("query is undefined for the index metric"));
        }

        let mut entry = self.entry;
        let mut entry_distance = self.distance_to_slice(query, entry);
        for layer in (1..=self.max_level).rev() {
            loop {
                let mut improved = false;
                for &neighbor in &self.links[entry as usize][layer] {
                    let candidate = self.distance_to_slice(query, neighbor);
                    if candidate < entry_distance {
                        entry = neighbor;
                        entry_distance = candidate;
                        improved = true;
                    }
                }
                if !improved {
                    break;
                }
            }
        }

        let ef = self.ef_search.max(top_k);
        let mut results = self.search_layer(query, entry, ef, 0);
        results.truncate(top_k);
        Ok(results.into_iter().map(|scored| Hit { id: scored.id as usize, distance: scored.distance }).collect())
    }

    fn insert_all(&mut self, count: usize) {
        // The first node becomes the entry point without any search.
        self.entry = 0;
        self.max_level = 0;
        self.levels[0] = 0;
        self.links[0] = vec![Vec::new()];
        for node in 1..count {
            self.insert(node as u32);
        }
    }

    fn insert(&mut self, node: u32) {
        let level = self.random_level();
        self.levels[node as usize] = level;
        self.links[node as usize] = vec![Vec::new(); level + 1];
        let query = self.vectors[node as usize].clone();

        let mut current = self.entry;
        let mut current_distance = self.distance_to_slice(&query, current);

        if level < self.max_level {
            for layer in ((level + 1)..=self.max_level).rev() {
                loop {
                    let mut improved = false;
                    for &neighbor in &self.links[current as usize][layer] {
                        let candidate = self.distance_to_slice(&query, neighbor);
                        if candidate < current_distance {
                            current = neighbor;
                            current_distance = candidate;
                            improved = true;
                        }
                    }
                    if !improved {
                        break;
                    }
                }
            }
        }

        for layer in (0..=level.min(self.max_level)).rev() {
            let candidates = self.search_layer(&query, current, self.ef_construction, layer);
            let selected = self.select_neighbors(&candidates, self.capacity(layer));
            for &neighbor in &selected {
                self.links[neighbor as usize][layer].push(node);
            }
            self.links[node as usize][layer] = selected.clone();
            for &neighbor in &selected {
                self.prune(neighbor, layer);
            }
            if let Some(nearest) = candidates.first() {
                current = nearest.id;
            }
        }

        if level > self.max_level {
            self.max_level = level;
            self.entry = node;
        }
    }

    /// Beam search on one layer. Returns at most `ef` nodes, nearest first.
    fn search_layer(&self, query: &[f32], entry: u32, ef: usize, layer: usize) -> Vec<Scored> {
        let mut visited: HashSet<u32> = HashSet::with_capacity(ef.saturating_mul(4).max(16));
        let mut candidates: BinaryHeap<Reverse<Scored>> = BinaryHeap::new();
        let mut results: BinaryHeap<Scored> = BinaryHeap::new();

        let start = Scored { id: entry, distance: self.distance_to_slice(query, entry) };
        visited.insert(entry);
        candidates.push(Reverse(start));
        results.push(start);

        while let Some(Reverse(current)) = candidates.pop() {
            if results.len() >= ef {
                if let Some(worst) = results.peek() {
                    if current.distance > worst.distance {
                        break;
                    }
                }
            }
            for &neighbor in &self.links[current.id as usize][layer] {
                if !visited.insert(neighbor) {
                    continue;
                }
                let candidate = Scored { id: neighbor, distance: self.distance_to_slice(query, neighbor) };
                let worst = results.peek().map_or(f64::INFINITY, |scored| scored.distance);
                if results.len() < ef || candidate.distance < worst {
                    candidates.push(Reverse(candidate));
                    results.push(candidate);
                    if results.len() > ef {
                        results.pop();
                    }
                }
            }
        }

        let mut ordered: Vec<Scored> = results.into_vec();
        ordered.sort();
        ordered
    }

    /// Diversity heuristic: keep a candidate only when it is closer to the
    /// query than to every neighbour already kept.
    fn select_neighbors(&self, candidates: &[Scored], m: usize) -> Vec<u32> {
        let mut selected: Vec<u32> = Vec::with_capacity(m.min(candidates.len()));
        for candidate in candidates {
            if selected.len() >= m {
                break;
            }
            let diverse =
                selected.iter().all(|&other| self.distance_between(candidate.id, other) >= candidate.distance);
            if diverse {
                selected.push(candidate.id);
            }
        }
        selected
    }

    fn prune(&mut self, node: u32, layer: usize) {
        let capacity = self.capacity(layer);
        if self.links[node as usize][layer].len() <= capacity {
            return;
        }
        let candidates: Vec<Scored> = {
            let links = &self.links[node as usize][layer];
            let mut scored: Vec<Scored> =
                links.iter().map(|&other| Scored { id: other, distance: self.distance_between(node, other) }).collect();
            scored.sort();
            scored
        };
        self.links[node as usize][layer] = self.select_neighbors(&candidates, capacity);
    }

    fn capacity(&self, layer: usize) -> usize {
        if layer == 0 {
            self.m0
        } else {
            self.m
        }
    }

    fn random_level(&mut self) -> usize {
        let uniform = self.rng.next_f64().max(1e-12);
        let level = (-uniform.ln() * self.level_multiplier).floor();
        (level as usize).min(MAX_LEVEL)
    }

    fn distance_to_slice(&self, query: &[f32], node: u32) -> f64 {
        distance(query, &self.vectors[node as usize], self.metric).unwrap_or(f64::INFINITY)
    }

    fn distance_between(&self, left: u32, right: u32) -> f64 {
        distance(&self.vectors[left as usize], &self.vectors[right as usize], self.metric).unwrap_or(f64::INFINITY)
    }

    /// Number of links stored on layer zero and on all upper layers, for
    /// diagnostics and tests.
    #[must_use]
    pub fn link_counts(&self) -> (usize, usize) {
        let layer0: usize = self.links.iter().map(|layers| layers[0].len()).sum();
        let upper: usize = self.links.iter().map(|layers| layers.iter().skip(1).map(Vec::len).sum::<usize>()).sum();
        (layer0, upper)
    }
}

impl fmt::Debug for HnswIndex {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("HnswIndex")
            .field("nodes", &self.vectors.len())
            .field("dimension", &self.dimension)
            .field("metric", &self.metric)
            .field("max_level", &self.max_level)
            .field("m", &self.m)
            .field("ef_construction", &self.ef_construction)
            .field("ef_search", &self.ef_search)
            .finish()
    }
}

#[derive(Debug, Clone, Copy)]
struct Scored {
    id: u32,
    distance: f64,
}

impl PartialEq for Scored {
    fn eq(&self, other: &Self) -> bool {
        self.id == other.id && self.distance.total_cmp(&other.distance) == Ordering::Equal
    }
}

impl Eq for Scored {}

impl Ord for Scored {
    fn cmp(&self, other: &Self) -> Ordering {
        self.distance.total_cmp(&other.distance).then_with(|| self.id.cmp(&other.id))
    }
}

impl PartialOrd for Scored {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

/// Deterministic SplitMix64, so a seed fully reproduces the graph.
struct Rng(u64);

impl Rng {
    fn new(seed: u64) -> Self {
        Self(seed)
    }

    fn next_u64(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9e37_79b9_7f4a_7c15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
        z ^ (z >> 31)
    }

    fn next_f64(&mut self) -> f64 {
        (self.next_u64() >> 11) as f64 / (1_u64 << 53) as f64
    }
}

fn validate_config(config: HnswConfig) -> Result<(), HnswError> {
    if config.m < 2 {
        return Err(HnswError::InvalidConfig("m must be at least 2"));
    }
    if config.m > 128 {
        return Err(HnswError::InvalidConfig("m must be at most 128"));
    }
    if config.ef_construction < config.m {
        return Err(HnswError::InvalidConfig("ef_construction must be at least m"));
    }
    if config.ef_search == 0 {
        return Err(HnswError::InvalidConfig("ef_search must be greater than zero"));
    }
    Ok(())
}

fn validate_dataset(vectors: &[Vec<f32>], metric: Metric) -> Result<usize, HnswError> {
    let Some(first) = vectors.first() else {
        return Err(HnswError::InvalidConfig("dataset must not be empty"));
    };
    let dimension = first.len();
    if dimension == 0 {
        return Err(HnswError::InvalidConfig("vectors must have a non-zero dimension"));
    }
    if dimension > u32::MAX as usize {
        return Err(HnswError::InvalidConfig("dimension exceeds the 32-bit index format"));
    }
    for (row, vector) in vectors.iter().enumerate() {
        if vector.len() != dimension {
            return Err(HnswError::Build(SearchError::DimensionMismatch { expected: dimension, actual: vector.len() }));
        }
        for (column, value) in vector.iter().enumerate() {
            if !value.is_finite() {
                return Err(HnswError::Build(SearchError::NonFiniteValue { row, dimension: column }));
            }
        }
        if metric == Metric::Cosine && distance(vector, vector, Metric::Cosine).is_none() {
            return Err(HnswError::Build(SearchError::ZeroVector { row }));
        }
    }
    Ok(dimension)
}

/// Serialized format marker; also carries the format revision.
const MAGIC: [u8; 8] = *b"WSQLHNS1";
const FORMAT_VERSION: u32 = 1;

impl HnswIndex {
    /// Serializes the graph into a self-describing, checksummed byte string.
    ///
    /// Layout (little endian): magic, version, header (dimension, metric, m, m0,
    /// ef parameters, entry, level, count), per-node levels, adjacency lists,
    /// vectors, then an FNV-1a checksum over everything before it.
    #[must_use]
    pub fn to_bytes(&self) -> Vec<u8> {
        let mut out = Vec::new();
        out.extend_from_slice(&MAGIC);
        push_u32(&mut out, FORMAT_VERSION);
        push_u32(&mut out, self.dimension as u32);
        push_u32(&mut out, self.metric.code());
        push_u32(&mut out, self.m as u32);
        push_u32(&mut out, self.m0 as u32);
        push_u32(&mut out, self.ef_construction as u32);
        push_u32(&mut out, self.ef_search as u32);
        push_u32(&mut out, self.entry);
        push_u32(&mut out, self.max_level as u32);
        push_u32(&mut out, self.vectors.len() as u32);
        for level in &self.levels {
            push_u32(&mut out, *level as u32);
        }
        for layers in &self.links {
            push_u32(&mut out, layers.len() as u32);
            for links in layers {
                push_u32(&mut out, links.len() as u32);
                for id in links {
                    push_u32(&mut out, *id);
                }
            }
        }
        for vector in &self.vectors {
            for value in vector {
                out.extend_from_slice(&value.to_le_bytes());
            }
        }
        let checksum = fnv1a(&out);
        out.extend_from_slice(&checksum.to_le_bytes());
        out
    }

    /// Restores an index produced by [`HnswIndex::to_bytes`].
    ///
    /// Every header field, adjacency id and vector value is validated, and the
    /// trailing checksum must match; a corrupt or truncated buffer is rejected
    /// instead of producing a graph that silently returns wrong neighbours.
    pub fn from_bytes(bytes: &[u8]) -> Result<Self, HnswError> {
        if bytes.len() < 8 {
            return Err(HnswError::Corrupt("index is shorter than its checksum"));
        }
        let (payload, checksum) = bytes.split_at(bytes.len() - 8);
        let expected = u64::from_le_bytes(checksum.try_into().expect("checksum is eight bytes"));
        if fnv1a(payload) != expected {
            return Err(HnswError::Corrupt("checksum mismatch"));
        }

        let mut cursor = Cursor::new(payload);
        if cursor.take(8)? != MAGIC {
            return Err(HnswError::Corrupt("bad magic"));
        }
        if cursor.u32()? != FORMAT_VERSION {
            return Err(HnswError::Corrupt("unsupported format version"));
        }
        let dimension = cursor.u32()? as usize;
        let Some(metric) = Metric::from_code(cursor.u32()?) else {
            return Err(HnswError::Corrupt("unknown metric"));
        };
        let m = cursor.u32()? as usize;
        let m0 = cursor.u32()? as usize;
        let ef_construction = cursor.u32()? as usize;
        let ef_search = cursor.u32()? as usize;
        let entry = cursor.u32()?;
        let max_level = cursor.u32()? as usize;
        let count = cursor.u32()? as usize;

        if count == 0 || dimension == 0 {
            return Err(HnswError::Corrupt("index is empty"));
        }
        if max_level > MAX_LEVEL {
            return Err(HnswError::Corrupt("maximum level is out of range"));
        }
        if m < 2 || m0 < m {
            return Err(HnswError::Corrupt("link capacities are inconsistent"));
        }
        if entry as usize >= count {
            return Err(HnswError::Corrupt("entry point is out of range"));
        }
        if count > payload.len() / 8 || dimension > payload.len() / 4 {
            return Err(HnswError::Corrupt("plausible header exceeds the buffer"));
        }

        let mut levels = Vec::with_capacity(count);
        for _ in 0..count {
            let level = cursor.u32()? as usize;
            if level > max_level {
                return Err(HnswError::Corrupt("node level exceeds the index maximum"));
            }
            levels.push(level);
        }
        if levels[entry as usize] != max_level {
            return Err(HnswError::Corrupt("entry point is not on the top layer"));
        }

        let mut links = Vec::with_capacity(count);
        for &level in &levels {
            let layers = cursor.u32()? as usize;
            if layers != level + 1 {
                return Err(HnswError::Corrupt("layer count does not match the node level"));
            }
            let mut per_layer = Vec::with_capacity(layers);
            for layer in 0..layers {
                let capacity = if layer == 0 { m0 } else { m };
                let degree = cursor.u32()? as usize;
                if degree > capacity {
                    return Err(HnswError::Corrupt("neighbour count exceeds the layer capacity"));
                }
                let mut neighbours = Vec::with_capacity(degree);
                for _ in 0..degree {
                    let id = cursor.u32()?;
                    if id as usize >= count {
                        return Err(HnswError::Corrupt("neighbour id is out of range"));
                    }
                    neighbours.push(id);
                }
                per_layer.push(neighbours);
            }
            links.push(per_layer);
        }

        let mut vectors = Vec::with_capacity(count);
        for _ in 0..count {
            let mut vector = Vec::with_capacity(dimension);
            for _ in 0..dimension {
                let value = cursor.f32()?;
                if !value.is_finite() {
                    return Err(HnswError::Corrupt("vector value is not finite"));
                }
                vector.push(value);
            }
            vectors.push(vector);
        }
        if cursor.remaining() != 0 {
            return Err(HnswError::Corrupt("trailing bytes after the vector block"));
        }

        Ok(Self {
            dimension,
            metric,
            vectors,
            levels,
            links,
            entry,
            max_level,
            m,
            m0,
            ef_construction,
            ef_search,
            rng: Rng::new(0),
            level_multiplier: 1.0 / (m as f64).ln(),
        })
    }
}

fn push_u32(out: &mut Vec<u8>, value: u32) {
    out.extend_from_slice(&value.to_le_bytes());
}

fn fnv1a(bytes: &[u8]) -> u64 {
    let mut hash = 0xcbf2_9ce4_8422_2325_u64;
    for &byte in bytes {
        hash ^= u64::from(byte);
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    hash
}

struct Cursor<'a> {
    bytes: &'a [u8],
    position: usize,
}

impl<'a> Cursor<'a> {
    fn new(bytes: &'a [u8]) -> Self {
        Self { bytes, position: 0 }
    }

    fn remaining(&self) -> usize {
        self.bytes.len() - self.position
    }

    fn take(&mut self, count: usize) -> Result<&'a [u8], HnswError> {
        if self.remaining() < count {
            return Err(HnswError::Corrupt("unexpected end of index"));
        }
        let start = self.position;
        self.position += count;
        Ok(&self.bytes[start..self.position])
    }

    fn u32(&mut self) -> Result<u32, HnswError> {
        Ok(u32::from_le_bytes(self.take(4)?.try_into().expect("four bytes")))
    }

    fn f32(&mut self) -> Result<f32, HnswError> {
        Ok(f32::from_le_bytes(self.take(4)?.try_into().expect("four bytes")))
    }
}
