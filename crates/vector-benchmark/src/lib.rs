//! Exact cosine-search baseline for WeiSQL AI.
//!
//! This deliberately favors clarity and deterministic semantics over speed.
//! It is a correctness oracle for later ANN comparisons, not a production index.

use std::cmp::Ordering;
use std::fmt;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SearchError {
    EmptyDataset,
    DimensionMismatch { expected: usize, actual: usize },
    ZeroVector { row: usize },
    NonFiniteValue { row: usize, dimension: usize },
    QueryZeroVector,
    QueryNonFiniteValue { dimension: usize },
}

impl fmt::Display for SearchError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::EmptyDataset => write!(f, "dataset must not be empty"),
            Self::DimensionMismatch { expected, actual } => write!(f, "dimension mismatch: expected {expected}, got {actual}"),
            Self::ZeroVector { row } => write!(f, "dataset row {row} is a zero vector"),
            Self::NonFiniteValue { row, dimension } => write!(f, "dataset row {row}, dimension {dimension} is not finite"),
            Self::QueryZeroVector => write!(f, "query vector must not be a zero vector for cosine distance"),
            Self::QueryNonFiniteValue { dimension } => write!(f, "query dimension {dimension} is not finite"),
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
pub fn validate_dataset(vectors: &[Vec<f32>]) -> Result<usize, SearchError> {
    let first = vectors.first().ok_or(SearchError::EmptyDataset)?;
    let dim = first.len();
    if dim == 0 {
        return Err(SearchError::DimensionMismatch { expected: 1, actual: 0 });
    }
    for (row, vector) in vectors.iter().enumerate() {
        if vector.len() != dim {
            return Err(SearchError::DimensionMismatch { expected: dim, actual: vector.len() });
        }
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
/// Ties are deterministically broken by ascending row ID.
pub fn exact_cosine_search(
    vectors: &[Vec<f32>],
    query: &[f32],
    top_k: usize,
) -> Result<Vec<Hit>, SearchError> {
    let dim = validate_dataset(vectors)?;
    if query.len() != dim {
        return Err(SearchError::DimensionMismatch { expected: dim, actual: query.len() });
    }
    for (dimension, value) in query.iter().enumerate() {
        if !value.is_finite() {
            return Err(SearchError::QueryNonFiniteValue { dimension });
        }
    }
    let query_norm = squared_norm(query).sqrt();
    if query_norm == 0.0 {
        return Err(SearchError::QueryZeroVector);
    }

    let mut hits = Vec::with_capacity(vectors.len());
    for (id, vector) in vectors.iter().enumerate() {
        let denom = squared_norm(vector).sqrt() * query_norm;
        let similarity = dot(vector, query) / denom;
        // Clamp floating point drift into the mathematical cosine range.
        let distance = 1.0_f32 - similarity.clamp(-1.0, 1.0);
        hits.push(Hit { id, distance });
    }
    hits.sort_by(|a, b| {
        a.distance.partial_cmp(&b.distance).unwrap_or(Ordering::Equal)
            .then_with(|| a.id.cmp(&b.id))
    });
    hits.truncate(top_k.min(hits.len()));
    Ok(hits)
}

fn dot(a: &[f32], b: &[f32]) -> f32 {
    a.iter().zip(b).map(|(x, y)| x * y).sum()
}

fn squared_norm(vector: &[f32]) -> f32 {
    vector.iter().map(|x| x * x).sum()
}
