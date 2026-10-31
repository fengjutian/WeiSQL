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
    DimensionMismatch { expected: usize, actual: usize },
    ZeroVector { row: usize },
    NonFiniteValue { row: usize, dimension: usize },
    QueryZeroVector,
    QueryNonFiniteValue { dimension: usize },
    InvalidTopK { top_k: usize, limit: usize },
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
        }
    }
}

impl std::error::Error for SearchError {}

#[derive(Debug, Clone, PartialEq)]
pub struct Hit {
    /// Stable numeric row identifier in this baseline. Production IDs must map to business IDs.
    pub id: usize,
    /// Cosine distance = 1 - cosine similarity. Smaller is better.
    pub distance: f32,
}

/// Validate a dataset and return its common dimension.
///
/// Runs a full scan: dimensions, finiteness and zero vectors are all checked.
/// `exact_cosine_search` validates in a single pass instead, so call this only
/// when you need validation without searching.
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

/// Exact brute-force cosine Top-K search.
///
/// Ties are deterministically broken by ascending row ID. The scan keeps a
/// fixed-capacity max heap, so memory is `O(top_k)` rather than `O(rows)`, and
/// candidate maintenance is `O(rows log top_k)`.
///
/// Query validation happens before the dataset scan; a dataset with both an
/// invalid query and an invalid row reports the query error first.
pub fn exact_cosine_search(
    vectors: &[Vec<f32>],
    query: &[f32],
    top_k: usize,
) -> Result<Vec<Hit>, SearchError> {
    if top_k == 0 || top_k > MAX_TOP_K {
        return Err(SearchError::InvalidTopK { top_k, limit: MAX_TOP_K });
    }
    let dim = common_dimension(vectors)?;
    if query.len() != dim {
        return Err(SearchError::DimensionMismatch { expected: dim, actual: query.len() });
    }

    let mut query_norm_squared = 0.0_f64;
    for (dimension, &value) in query.iter().enumerate() {
        if !value.is_finite() {
            return Err(SearchError::QueryNonFiniteValue { dimension });
        }
        let value = f64::from(value);
        query_norm_squared += value * value;
    }
    if query_norm_squared == 0.0 {
        return Err(SearchError::QueryZeroVector);
    }

    let capacity = top_k.min(vectors.len());
    let mut best = BinaryHeap::with_capacity(capacity);
    for (id, vector) in vectors.iter().enumerate() {
        let mut dot = 0.0_f64;
        let mut norm_squared = 0.0_f64;
        for (dimension, (&value, &query_value)) in vector.iter().zip(query).enumerate() {
            if !value.is_finite() {
                return Err(SearchError::NonFiniteValue { row: id, dimension });
            }
            let value = f64::from(value);
            let query_value = f64::from(query_value);
            dot += value * query_value;
            norm_squared += value * value;
        }
        if norm_squared == 0.0 {
            return Err(SearchError::ZeroVector { row: id });
        }
        let similarity = dot / (norm_squared * query_norm_squared).sqrt();
        // Clamp floating point drift into the mathematical cosine range.
        let distance = (1.0_f64 - similarity.clamp(-1.0, 1.0)) as f32;
        offer(&mut best, Ranked { id, distance }, capacity);
    }

    Ok(best.into_sorted_vec().into_iter().map(Hit::from).collect())
}

/// Heap entry ordered worst-first, so `BinaryHeap::peek` is the worst kept hit.
#[derive(Debug, Clone, Copy, PartialEq)]
struct Ranked {
    id: usize,
    distance: f32,
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
        Self { id: ranked.id, distance: ranked.distance }
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
            return Err(SearchError::DimensionMismatch { expected: dim, actual: vector.len() });
        }
    }
    Ok(dim)
}

fn squared_norm(vector: &[f32]) -> f64 {
    vector.iter().map(|&x| f64::from(x) * f64::from(x)).sum()
}
