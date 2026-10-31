//! Exact cosine-search baseline for WeiSQL AI.
//!
//! This deliberately favors clarity and deterministic semantics over speed.
//! It is a correctness oracle for later ANN comparisons, not a production index.
//!
//! Contracts shared with the TypeScript exact search
//! (`packages/sdk/src/exact-vector-search.ts`):
//!
//! - cosine distance is `1 - similarity`, clamped into `[0, 2]`;
//! - ascending distance, ties broken by ascending row id;
//! - `top_k` must be in `1..=100_000`;
//! - every dataset and query value must be finite and non-zero;
//! - dot products and norms are accumulated in `f64` so that squaring tiny
//!   `f32` values cannot underflow into a false zero norm.

use std::cmp::Ordering;
use std::collections::BinaryHeap;
use std::fmt;

/// Upper bound mirroring the TypeScript exact-search contract.
pub const MAX_TOP_K: usize = 100_000;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SearchError {
    EmptyDataset,
    EmptyDimension,
    DimensionMismatch {
        expected: usize,
        actual: usize,
    },
    ZeroVector {
        row: usize,
    },
    NonFiniteValue {
        row: usize,
        dimension: usize,
    },
    QueryZeroVector,
    QueryNonFiniteValue {
        dimension: usize,
    },
    InvalidTopK {
        top_k: usize,
        limit: usize,
    },
    BufferLengthMismatch {
        rows: usize,
        dimension: usize,
        actual: usize,
    },
}

impl SearchError {
    /// Stable code shared with the TypeScript `WeiSQLError` taxonomy.
    #[must_use]
    pub fn code(&self) -> &'static str {
        match self {
            Self::EmptyDataset
            | Self::ZeroVector { .. }
            | Self::NonFiniteValue { .. }
            | Self::QueryZeroVector
            | Self::QueryNonFiniteValue { .. } => "VECTOR_INVALID_VALUE",
            Self::EmptyDimension | Self::DimensionMismatch { .. } => "VECTOR_DIMENSION_MISMATCH",
            Self::InvalidTopK { .. } => "INVALID_ARGUMENT",
            Self::BufferLengthMismatch { .. } => "VECTOR_INVALID_VALUE",
        }
    }
}

impl fmt::Display for SearchError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::EmptyDataset => write!(f, "dataset must not be empty"),
            Self::EmptyDimension => write!(f, "vectors must have a non-zero dimension"),
            Self::DimensionMismatch { expected, actual } => {
                write!(f, "dimension mismatch: expected {expected}, got {actual}")
            }
            Self::ZeroVector { row } => write!(f, "dataset row {row} is a zero vector"),
            Self::NonFiniteValue { row, dimension } => {
                write!(f, "dataset row {row}, dimension {dimension} is not finite")
            }
            Self::QueryZeroVector => {
                write!(f, "query vector must not be a zero vector for cosine distance")
            }
            Self::QueryNonFiniteValue { dimension } => {
                write!(f, "query dimension {dimension} is not finite")
            }
            Self::InvalidTopK { top_k, limit } => {
                write!(f, "top_k must be between 1 and {limit}, got {top_k}")
            }
            Self::BufferLengthMismatch {
                rows,
                dimension,
                actual,
            } => write!(
                f,
                "vector buffer has {actual} values but {rows} rows of {dimension} were expected"
            ),
        }
    }
}

impl std::error::Error for SearchError {}

#[derive(Debug, Clone, PartialEq)]
pub struct Hit {
    /// Stable numeric row identifier in this baseline. Production IDs must map to business IDs.
    pub id: usize,
    /// Distance under the selected metric. Smaller is better.
    ///
    /// Kept in `f64` on purpose: summing `f32` inputs can exceed `f32::MAX`
    /// (an inner product of two large vectors, or an L2 distance in high
    /// dimensions), and saturating would destroy the ordering that callers rely
    /// on.
    pub distance: f64,
}

/// Distance between two vectors under `metric`, accumulated in `f64`.
///
/// Returns `None` when the distance is undefined: mismatched lengths, empty
/// slices, or a cosine distance involving a zero vector. Inputs are assumed
/// finite; [`validate_dataset`] is the guard for that.
#[must_use]
pub fn distance(left: &[f32], right: &[f32], metric: Metric) -> Option<f64> {
    if left.is_empty() || left.len() != right.len() {
        return None;
    }
    let (cosine, l2) = (metric == Metric::Cosine, metric == Metric::L2);
    let mut dot = 0.0_f64;
    let mut left_norm = 0.0_f64;
    let mut right_norm = 0.0_f64;
    let mut squared = 0.0_f64;
    for (&left_value, &right_value) in left.iter().zip(right) {
        let left_value = f64::from(left_value);
        let right_value = f64::from(right_value);
        dot += left_value * right_value;
        if cosine {
            left_norm += left_value * left_value;
            right_norm += right_value * right_value;
        }
        if l2 {
            let difference = left_value - right_value;
            squared += difference * difference;
        }
    }
    match metric {
        Metric::Cosine => {
            if left_norm == 0.0 || right_norm == 0.0 {
                None
            } else {
                Some(1.0_f64 - (dot / (left_norm * right_norm).sqrt()).clamp(-1.0, 1.0))
            }
        }
        Metric::L2 => Some(squared.sqrt()),
        Metric::Ip => Some(-dot),
    }
}

/// Validate a dataset for cosine search and return its common dimension.
///
/// Runs a full scan: dimensions, finiteness and zero vectors are all checked.
/// `exact_cosine_search` validates in a single pass instead, so call this only
/// when you need validation without searching. L2 and inner-product search
/// accept zero vectors and therefore do not use this check.
pub fn validate_dataset(vectors: &[Vec<f32>]) -> Result<usize, SearchError> {
    let dim = common_dimension(vectors)?;
    for (row, vector) in vectors.iter().enumerate() {
        for (dimension, value) in vector.iter().enumerate() {
            if !value.is_finite() {
                return Err(SearchError::NonFiniteValue { row, dimension });
            }
        }
        if squared_norm(vector) == 0.0 {
            return Err(SearchError::ZeroVector { row });
        }
    }
    Ok(dim)
}

/// Distance metric for exact search.
///
/// All metrics return a finite distance where smaller means more similar, and
/// ties are broken by ascending row id.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Metric {
    /// `1 - cosine similarity`, clamped into `[0, 2]`; rejects zero vectors.
    Cosine,
    /// Euclidean distance `sqrt(sum((a - b)^2))`.
    L2,
    /// Negative inner product `-dot(a, b)`.
    Ip,
}

impl Metric {
    /// Maps the WASM/FFI code: `0` cosine, `1` L2, `2` inner product.
    #[must_use]
    pub fn from_code(code: u32) -> Option<Self> {
        match code {
            0 => Some(Self::Cosine),
            1 => Some(Self::L2),
            2 => Some(Self::Ip),
            _ => None,
        }
    }

    /// Inverse of [`Metric::from_code`].
    #[must_use]
    pub fn code(self) -> u32 {
        match self {
            Self::Cosine => 0,
            Self::L2 => 1,
            Self::Ip => 2,
        }
    }
}

/// Exact brute-force cosine Top-K search over `Vec`-per-row storage.
///
/// Ties are deterministically broken by ascending row ID. The scan keeps a
/// fixed-capacity max heap, so memory is `O(top_k)` rather than `O(rows)`, and
/// candidate maintenance is `O(rows log top_k)`.
///
/// Query validation happens before the dataset scan; a dataset with both an
/// invalid query and an invalid row reports the query error first.
pub fn exact_cosine_search(vectors: &[Vec<f32>], query: &[f32], top_k: usize) -> Result<Vec<Hit>, SearchError> {
    exact_search(vectors, query, top_k, Metric::Cosine)
}

/// Exact cosine search over a single row-major buffer.
///
/// This is the zero-copy entry point: it reads the same layout as an on-disk
/// Float32 block (and the WASM shim) without allocating one `Vec` per row.
pub fn exact_cosine_search_contiguous(
    vectors: &[f32],
    rows: usize,
    dimension: usize,
    query: &[f32],
    top_k: usize,
) -> Result<Vec<Hit>, SearchError> {
    exact_search_contiguous(vectors, rows, dimension, query, top_k, Metric::Cosine)
}

/// Exact Top-K search over `Vec`-per-row storage for any [`Metric`].
pub fn exact_search(
    vectors: &[Vec<f32>],
    query: &[f32],
    top_k: usize,
    metric: Metric,
) -> Result<Vec<Hit>, SearchError> {
    check_top_k(top_k)?;
    let dim = common_dimension(vectors)?;
    search(
        vectors.len(),
        dim,
        vectors.iter().map(Vec::as_slice),
        query,
        top_k,
        metric,
    )
}

/// Exact Top-K search over one contiguous row-major buffer for any [`Metric`].
pub fn exact_search_contiguous(
    vectors: &[f32],
    rows: usize,
    dimension: usize,
    query: &[f32],
    top_k: usize,
    metric: Metric,
) -> Result<Vec<Hit>, SearchError> {
    check_top_k(top_k)?;
    if rows == 0 {
        return Err(SearchError::EmptyDataset);
    }
    if dimension == 0 {
        return Err(SearchError::EmptyDimension);
    }
    let expected = rows.checked_mul(dimension).ok_or(SearchError::BufferLengthMismatch {
        rows,
        dimension,
        actual: vectors.len(),
    })?;
    if vectors.len() != expected {
        return Err(SearchError::BufferLengthMismatch {
            rows,
            dimension,
            actual: vectors.len(),
        });
    }
    search(rows, dimension, vectors.chunks_exact(dimension), query, top_k, metric)
}

fn check_top_k(top_k: usize) -> Result<(), SearchError> {
    if top_k == 0 || top_k > MAX_TOP_K {
        return Err(SearchError::InvalidTopK {
            top_k,
            limit: MAX_TOP_K,
        });
    }
    Ok(())
}

fn search<'a, I>(
    rows: usize,
    dim: usize,
    vectors: I,
    query: &[f32],
    top_k: usize,
    metric: Metric,
) -> Result<Vec<Hit>, SearchError>
where
    I: Iterator<Item = &'a [f32]>,
{
    if query.len() != dim {
        return Err(SearchError::DimensionMismatch {
            expected: dim,
            actual: query.len(),
        });
    }

    let cosine = metric == Metric::Cosine;
    let l2 = metric == Metric::L2;
    let mut query_norm_squared = 0.0_f64;
    for (dimension, &value) in query.iter().enumerate() {
        if !value.is_finite() {
            return Err(SearchError::QueryNonFiniteValue { dimension });
        }
        if cosine {
            let value = f64::from(value);
            query_norm_squared += value * value;
        }
    }
    if cosine && query_norm_squared == 0.0 {
        return Err(SearchError::QueryZeroVector);
    }

    let capacity = top_k.min(rows);
    let mut best = BinaryHeap::with_capacity(capacity);
    for (id, vector) in vectors.enumerate() {
        debug_assert_eq!(vector.len(), dim);
        let mut dot = 0.0_f64;
        let mut norm_squared = 0.0_f64;
        let mut squared_distance = 0.0_f64;
        for (dimension, (&value, &query_value)) in vector.iter().zip(query).enumerate() {
            if !value.is_finite() {
                return Err(SearchError::NonFiniteValue { row: id, dimension });
            }
            let value = f64::from(value);
            let query_value = f64::from(query_value);
            dot += value * query_value;
            if cosine {
                norm_squared += value * value;
            }
            if l2 {
                let difference = value - query_value;
                squared_distance += difference * difference;
            }
        }
        let distance = match metric {
            Metric::Cosine => {
                if norm_squared == 0.0 {
                    return Err(SearchError::ZeroVector { row: id });
                }
                let similarity = dot / (norm_squared * query_norm_squared).sqrt();
                // Clamp floating point drift into the mathematical cosine range.
                1.0_f64 - similarity.clamp(-1.0, 1.0)
            }
            Metric::L2 => squared_distance.sqrt(),
            Metric::Ip => -dot,
        };
        offer(&mut best, Ranked { id, distance }, capacity);
    }

    Ok(best.into_sorted_vec().into_iter().map(Hit::from).collect())
}

/// Heap entry ordered worst-first, so `BinaryHeap::peek` is the worst kept hit.
#[derive(Debug, Clone, Copy, PartialEq)]
struct Ranked {
    id: usize,
    distance: f64,
}

impl Eq for Ranked {}

impl Ord for Ranked {
    fn cmp(&self, other: &Self) -> Ordering {
        self.distance
            .total_cmp(&other.distance)
            .then_with(|| self.id.cmp(&other.id))
    }
}

impl PartialOrd for Ranked {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

impl From<Ranked> for Hit {
    fn from(ranked: Ranked) -> Self {
        Self {
            id: ranked.id,
            distance: ranked.distance,
        }
    }
}

/// Keeps the `capacity` best candidates; `candidate` must be better than the
/// current worst to enter a full heap.
fn offer(heap: &mut BinaryHeap<Ranked>, candidate: Ranked, capacity: usize) {
    if heap.len() < capacity {
        heap.push(candidate);
        return;
    }
    if heap.peek().is_some_and(|worst| candidate < *worst) {
        heap.pop();
        heap.push(candidate);
    }
}

fn common_dimension(vectors: &[Vec<f32>]) -> Result<usize, SearchError> {
    let first = vectors.first().ok_or(SearchError::EmptyDataset)?;
    let dim = first.len();
    if dim == 0 {
        return Err(SearchError::EmptyDimension);
    }
    for vector in vectors {
        if vector.len() != dim {
            return Err(SearchError::DimensionMismatch {
                expected: dim,
                actual: vector.len(),
            });
        }
    }
    Ok(dim)
}

fn squared_norm(vector: &[f32]) -> f64 {
    vector.iter().map(|&x| f64::from(x) * f64::from(x)).sum()
}
