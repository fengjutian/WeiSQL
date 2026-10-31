//! HNSW behaviour tests: structural bounds, determinism, and recall against the
//! exact baseline. Recall thresholds are deliberately loose enough to be stable
//! on the fixed synthetic datasets but tight enough to catch a broken graph.

use weisql_vector_benchmark::{distance, exact_search, Metric, SearchError};
use weisql_vector_hnsw::{HnswConfig, HnswError, HnswIndex};

const METRICS: [Metric; 3] = [Metric::Cosine, Metric::L2, Metric::Ip];

fn random_vectors(count: usize, dimension: usize, seed: u64) -> Vec<Vec<f32>> {
    let mut rng = Lcg::new(seed);
    (0..count).map(|_| (0..dimension).map(|_| rng.next_f32() * 2.0).collect()).collect()
}

fn clustered_vectors(count: usize, dimension: usize, clusters: usize, seed: u64) -> Vec<Vec<f32>> {
    let mut rng = Lcg::new(seed);
    let centers: Vec<Vec<f32>> =
        (0..clusters).map(|_| (0..dimension).map(|_| rng.next_f32() * 20.0).collect()).collect();
    (0..count)
        .map(|_| {
            let center = &centers[rng.next_usize(clusters)];
            (0..dimension).map(|column| center[column] + rng.next_f32() * 0.5).collect()
        })
        .collect()
}

fn recall(index: &HnswIndex, vectors: &[Vec<f32>], metric: Metric, top_k: usize) -> f64 {
    let mut hits = 0;
    let mut total = 0;
    for query in vectors.iter().take(50) {
        let expected = exact_search(vectors, query, top_k, metric).unwrap();
        let actual = index.search(query, top_k).unwrap();
        let expected_ids: Vec<usize> = expected.iter().map(|hit| hit.id).collect();
        for hit in &actual {
            if expected_ids.contains(&hit.id) {
                hits += 1;
            }
        }
        total += expected_ids.len();
    }
    hits as f64 / total as f64
}

fn config(m: usize, ef_construction: usize, ef_search: usize) -> HnswConfig {
    HnswConfig { m, ef_construction, ef_search, seed: 42 }
}

#[test]
fn links_stay_within_capacity() {
    let vectors = random_vectors(200, 8, 1);
    let index = HnswIndex::build(vectors, Metric::L2, config(8, 64, 32)).unwrap();
    let (layer0, upper) = index.link_counts();
    assert!(layer0 <= 200 * 16, "layer zero links: {layer0}");
    assert!(upper <= 200 * 8 * 4, "upper layer links: {upper}");
    assert!(!index.is_empty());
    assert_eq!(index.len(), 200);
    assert_eq!(index.dimension(), 8);
    assert_eq!(index.metric(), Metric::L2);
}

#[test]
fn single_vector_returns_itself() {
    let index = HnswIndex::build(vec![vec![1.0, 2.0, 3.0]], Metric::L2, HnswConfig::default()).unwrap();
    let hits = index.search(&[1.0, 2.0, 3.0], 1).unwrap();
    assert_eq!(hits.len(), 1);
    assert_eq!(hits[0].id, 0);
    assert!(hits[0].distance.abs() < 1e-9);
}

#[test]
fn reported_distances_match_the_metric() {
    let vectors = random_vectors(120, 6, 2);
    let index = HnswIndex::build(vectors.clone(), Metric::Cosine, config(8, 64, 32)).unwrap();
    let query = &vectors[7];
    for hit in index.search(query, 10).unwrap() {
        let expected = distance(query, &vectors[hit.id], Metric::Cosine).unwrap();
        assert!((hit.distance - expected).abs() < 1e-12, "hit {}: {} vs {expected}", hit.id, hit.distance);
    }
}

#[test]
fn random_data_recall_is_high_for_every_metric() {
    for &metric in &METRICS {
        let vectors = random_vectors(400, 16, 3);
        let index = HnswIndex::build(vectors.clone(), metric, config(12, 120, 96)).unwrap();
        // Cosine on random vectors is intrinsically harder: directions cluster.
        let threshold = if metric == Metric::Cosine { 0.85 } else { 0.95 };
        let value = recall(&index, &vectors, metric, 10);
        assert!(value >= threshold, "{metric:?} recall {value:.3} < {threshold}");
    }
}

#[test]
fn clustered_data_recall_is_reasonable() {
    let vectors = clustered_vectors(600, 24, 6, 4);
    let index = HnswIndex::build(vectors.clone(), Metric::L2, config(12, 160, 96)).unwrap();
    let value = recall(&index, &vectors, Metric::L2, 10);
    assert!(value >= 0.9, "clustered L2 recall {value:.3}");
}

#[test]
fn builds_are_deterministic() {
    let vectors = random_vectors(150, 10, 5);
    let first = HnswIndex::build(vectors.clone(), Metric::L2, config(8, 80, 40)).unwrap();
    let second = HnswIndex::build(vectors, Metric::L2, config(8, 80, 40)).unwrap();
    let query = vec![0.25_f32; 10];
    let left: Vec<usize> = first.search(&query, 10).unwrap().iter().map(|hit| hit.id).collect();
    let right: Vec<usize> = second.search(&query, 10).unwrap().iter().map(|hit| hit.id).collect();
    assert_eq!(left, right);
}

#[test]
fn top_k_is_respected_and_sorted() {
    let vectors = random_vectors(80, 5, 6);
    let index = HnswIndex::build(vectors.clone(), Metric::L2, config(8, 64, 32)).unwrap();
    let hits = index.search(&vectors[0], 5).unwrap();
    assert_eq!(hits.len(), 5);
    for pair in hits.windows(2) {
        assert!(pair[0].distance <= pair[1].distance);
        if (pair[0].distance - pair[1].distance).abs() < f64::EPSILON {
            assert!(pair[0].id < pair[1].id);
        }
    }
}

#[test]
fn rejects_invalid_configuration() {
    let vectors = vec![vec![1.0, 0.0]];
    assert_eq!(
        HnswIndex::build(vectors.clone(), Metric::L2, config(1, 10, 10)).unwrap_err(),
        HnswError::InvalidConfig("m must be at least 2")
    );
    assert_eq!(
        HnswIndex::build(vectors.clone(), Metric::L2, config(8, 4, 10)).unwrap_err(),
        HnswError::InvalidConfig("ef_construction must be at least m")
    );
    assert_eq!(
        HnswIndex::build(vectors, Metric::L2, config(8, 10, 0)).unwrap_err(),
        HnswError::InvalidConfig("ef_search must be greater than zero")
    );
}

#[test]
fn rejects_invalid_datasets() {
    assert_eq!(
        HnswIndex::build(Vec::new(), Metric::L2, HnswConfig::default()).unwrap_err(),
        HnswError::InvalidConfig("dataset must not be empty")
    );
    assert_eq!(
        HnswIndex::build(vec![vec![1.0], vec![1.0, 2.0]], Metric::L2, HnswConfig::default()).unwrap_err(),
        HnswError::Build(SearchError::DimensionMismatch { expected: 1, actual: 2 })
    );
    assert_eq!(
        HnswIndex::build(vec![vec![1.0, f32::NAN]], Metric::L2, HnswConfig::default()).unwrap_err(),
        HnswError::Build(SearchError::NonFiniteValue { row: 0, dimension: 1 })
    );
    assert_eq!(
        HnswIndex::build(vec![vec![0.0, 0.0]], Metric::Cosine, HnswConfig::default()).unwrap_err(),
        HnswError::Build(SearchError::ZeroVector { row: 0 })
    );
}

#[test]
fn rejects_invalid_queries() {
    let index = HnswIndex::build(vec![vec![1.0, 0.0], vec![0.0, 1.0]], Metric::Cosine, HnswConfig::default()).unwrap();
    assert_eq!(
        index.search(&[1.0], 1).unwrap_err(),
        HnswError::InvalidQuery("query dimension does not match the index")
    );
    assert_eq!(index.search(&[1.0, 0.0], 0).unwrap_err(), HnswError::InvalidQuery("top_k must be greater than zero"));
    assert_eq!(
        index.search(&[0.0, 0.0], 1).unwrap_err(),
        HnswError::InvalidQuery("query is undefined for the index metric")
    );
    assert_eq!(HnswError::InvalidQuery("x").code(), "VECTOR_INVALID_VALUE");
}

/// Deterministic 64-bit LCG shared with the other Rust tests.
struct Lcg(u64);

impl Lcg {
    fn new(seed: u64) -> Self {
        Self(seed.wrapping_mul(2_862_933_555_777_941_757).wrapping_add(3_037_000_493))
    }

    fn next_u64(&mut self) -> u64 {
        self.0 = self.0.wrapping_mul(6_364_136_223_846_793_005).wrapping_add(1_442_695_040_888_963_407);
        self.0
    }

    fn next_f32(&mut self) -> f32 {
        ((self.next_u64() >> 40) as f32) / ((1_u32 << 24) as f32) - 0.5
    }

    fn next_usize(&mut self, bound: usize) -> usize {
        (self.next_u64() % bound as u64) as usize
    }
}
