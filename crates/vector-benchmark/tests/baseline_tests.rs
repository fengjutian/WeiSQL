use weisql_vector_benchmark::{exact_cosine_search, validate_dataset, SearchError};

#[test]
fn ranks_identical_direction_first() {
    let vectors = vec![vec![1.0, 0.0], vec![0.0, 1.0], vec![2.0, 0.0], vec![-1.0, 0.0]];
    let hits = exact_cosine_search(&vectors, &[1.0, 0.0], 3).unwrap();
    assert_eq!(hits.iter().map(|h| h.id).collect::<Vec<_>>(), vec![0, 2, 1]);
    assert!(hits[0].distance.abs() < 1e-6);
    assert!((hits[2].distance - 1.0).abs() < 1e-6);
}

#[test]
fn ties_use_ascending_id() {
    let vectors = vec![vec![1.0, 0.0], vec![0.0, 1.0], vec![1.0, 0.0]];
    let hits = exact_cosine_search(&vectors, &[1.0, 1.0], 3).unwrap();
    assert_eq!(hits.iter().map(|h| h.id).collect::<Vec<_>>(), vec![0, 1, 2]);
}

#[test]
fn top_k_is_capped_at_dataset_size() {
    let vectors = vec![vec![1.0, 0.0]];
    assert_eq!(exact_cosine_search(&vectors, &[1.0, 0.0], 10).unwrap().len(), 1);
}

#[test]
fn rejects_zero_dataset_vector() {
    assert_eq!(validate_dataset(&[vec![0.0, 0.0]]), Err(SearchError::ZeroVector { row: 0 }));
}

#[test]
fn rejects_dimension_mismatch() {
    let err = exact_cosine_search(&[vec![1.0, 0.0]], &[1.0], 1).unwrap_err();
    assert_eq!(err, SearchError::DimensionMismatch { expected: 2, actual: 1 });
}

#[test]
fn rejects_non_finite_dataset_values() {
    assert_eq!(validate_dataset(&[vec![1.0, f32::NAN]]), Err(SearchError::NonFiniteValue { row: 0, dimension: 1 }));
}

#[test]
fn rejects_zero_query() {
    let err = exact_cosine_search(&[vec![1.0, 0.0]], &[0.0, 0.0], 1).unwrap_err();
    assert_eq!(err, SearchError::QueryZeroVector);
}
