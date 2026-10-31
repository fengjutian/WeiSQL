use weisql_vector_benchmark::{
    exact_cosine_search, exact_cosine_search_contiguous, exact_search, exact_search_contiguous, validate_dataset,
    Metric, SearchError, MAX_TOP_K,
};

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
fn tie_breaking_holds_under_truncation() {
    let vectors = vec![vec![1.0, 0.0]; 8];
    let hits = exact_cosine_search(&vectors, &[1.0, 0.0], 2).unwrap();
    assert_eq!(hits.iter().map(|h| h.id).collect::<Vec<_>>(), vec![0, 1]);
}

#[test]
fn top_k_is_capped_at_dataset_size() {
    let vectors = vec![vec![1.0, 0.0]];
    assert_eq!(exact_cosine_search(&vectors, &[1.0, 0.0], 10).unwrap().len(), 1);
}

#[test]
fn opposite_direction_is_distance_two() {
    let hits = exact_cosine_search(&[vec![1.0, 2.0]], &[-1.0, -2.0], 1).unwrap();
    assert!((hits[0].distance - 2.0).abs() < 1e-6);
}

#[test]
fn rejects_zero_dataset_vector() {
    assert_eq!(
        validate_dataset(&[vec![0.0, 0.0]]),
        Err(SearchError::ZeroVector { row: 0 })
    );
    assert_eq!(
        exact_cosine_search(&[vec![1.0, 1.0], vec![0.0, 0.0]], &[1.0, 0.0], 1),
        Err(SearchError::ZeroVector { row: 1 })
    );
}

#[test]
fn rejects_zero_query() {
    let err = exact_cosine_search(&[vec![1.0, 0.0]], &[0.0, 0.0], 1).unwrap_err();
    assert_eq!(err, SearchError::QueryZeroVector);
}

#[test]
fn rejects_dimension_mismatch() {
    let err = exact_cosine_search(&[vec![1.0, 0.0]], &[1.0], 1).unwrap_err();
    assert_eq!(err, SearchError::DimensionMismatch { expected: 2, actual: 1 });

    let err = exact_cosine_search(&[vec![1.0, 0.0]], &[1.0, 0.0, 0.0], 1).unwrap_err();
    assert_eq!(err, SearchError::DimensionMismatch { expected: 2, actual: 3 });
}

#[test]
fn rejects_ragged_dataset() {
    let err = exact_cosine_search(&[vec![1.0, 0.0], vec![1.0]], &[1.0, 0.0], 1).unwrap_err();
    assert_eq!(err, SearchError::DimensionMismatch { expected: 2, actual: 1 });
}

#[test]
fn rejects_empty_dataset() {
    assert_eq!(validate_dataset(&[]), Err(SearchError::EmptyDataset));
    assert_eq!(exact_cosine_search(&[], &[1.0], 1), Err(SearchError::EmptyDataset));
}

#[test]
fn rejects_zero_dimension() {
    assert_eq!(validate_dataset(&[vec![]]), Err(SearchError::EmptyDimension));
    let err = exact_cosine_search(&[vec![], vec![]], &[], 1).unwrap_err();
    assert_eq!(err, SearchError::EmptyDimension);
}

#[test]
fn rejects_non_finite_dataset_values() {
    assert_eq!(
        validate_dataset(&[vec![1.0, f32::NAN]]),
        Err(SearchError::NonFiniteValue { row: 0, dimension: 1 })
    );
    assert_eq!(
        exact_cosine_search(&[vec![1.0, f32::INFINITY]], &[1.0, 0.0], 1),
        Err(SearchError::NonFiniteValue { row: 0, dimension: 1 })
    );
}

#[test]
fn rejects_non_finite_query() {
    let err = exact_cosine_search(&[vec![1.0, 0.0]], &[f32::NAN, 0.0], 1).unwrap_err();
    assert_eq!(err, SearchError::QueryNonFiniteValue { dimension: 0 });
}

#[test]
fn rejects_out_of_range_top_k() {
    let vectors = [vec![1.0, 0.0]];
    assert_eq!(
        exact_cosine_search(&vectors, &[1.0, 0.0], 0),
        Err(SearchError::InvalidTopK {
            top_k: 0,
            limit: MAX_TOP_K
        })
    );
    assert_eq!(
        exact_cosine_search(&vectors, &[1.0, 0.0], MAX_TOP_K + 1),
        Err(SearchError::InvalidTopK {
            top_k: MAX_TOP_K + 1,
            limit: MAX_TOP_K
        })
    );
}

#[test]
fn tiny_values_do_not_underflow_to_zero() {
    // f32 squares underflow below ~1e-19; accumulating in f32 would report a
    // false zero-vector error here.
    let tiny = f32::MIN_POSITIVE / 4.0;
    let hits = exact_cosine_search(&[vec![tiny, 0.0]], &[1.0, 0.0], 1).unwrap();
    assert!(hits[0].distance.abs() < 1e-6, "distance was {}", hits[0].distance);
}

#[test]
fn distances_stay_in_the_cosine_range() {
    let mut random = Lcg::new(7);
    let vectors: Vec<Vec<f32>> = (0..200).map(|_| (0..16).map(|_| random.next_f32()).collect()).collect();
    let query: Vec<f32> = (0..16).map(|_| random.next_f32()).collect();
    for hit in exact_cosine_search(&vectors, &query, 200).unwrap() {
        assert!((0.0..=2.0).contains(&hit.distance), "distance was {}", hit.distance);
    }
}

#[test]
fn heap_matches_full_sort_for_random_data() {
    let mut random = Lcg::new(42);
    for trial in 0..8 {
        let rows = 1 + trial * 13;
        let dim = 1 + trial % 5;
        let vectors: Vec<Vec<f32>> = (0..rows)
            .map(|_| (0..dim).map(|_| random.next_f32() * 100.0).collect())
            .collect();
        let query: Vec<f32> = (0..dim).map(|_| random.next_f32()).collect();
        let expected = brute_force(&vectors, &query);
        for &top_k in &[1_usize, 2, 5, 21] {
            let actual = exact_cosine_search(&vectors, &query, top_k).unwrap();
            let limit = top_k.min(rows);
            assert_eq!(actual.len(), limit);
            for (hit, (id, distance)) in actual.iter().zip(expected.iter().take(limit)) {
                assert_eq!(hit.id, *id, "top_k={top_k} trial={trial}");
                assert!(
                    (f64::from(hit.distance) - distance).abs() < 1e-6,
                    "top_k={top_k} trial={trial}: {} vs {distance}",
                    hit.distance
                );
            }
        }
    }
}

#[test]
fn error_codes_match_the_typescript_taxonomy() {
    assert_eq!(SearchError::EmptyDataset.code(), "VECTOR_INVALID_VALUE");
    assert_eq!(
        SearchError::DimensionMismatch { expected: 1, actual: 2 }.code(),
        "VECTOR_DIMENSION_MISMATCH"
    );
    assert_eq!(SearchError::EmptyDimension.code(), "VECTOR_DIMENSION_MISMATCH");
    assert_eq!(
        SearchError::InvalidTopK {
            top_k: 0,
            limit: MAX_TOP_K
        }
        .code(),
        "INVALID_ARGUMENT"
    );
    assert_eq!(SearchError::QueryZeroVector.code(), "VECTOR_INVALID_VALUE");
    assert_eq!(
        SearchError::NonFiniteValue { row: 0, dimension: 0 }.code(),
        "VECTOR_INVALID_VALUE"
    );
}

#[test]
fn validate_dataset_reports_the_common_dimension() {
    assert_eq!(validate_dataset(&[vec![1.0, 2.0, 3.0], vec![4.0, 5.0, 6.0]]), Ok(3));
}

#[test]
fn contiguous_matches_the_vec_api() {
    let mut random = Lcg::new(11);
    for &(rows, dim) in &[(1_usize, 1_usize), (7, 3), (24, 8), (16, 32)] {
        let vectors: Vec<Vec<f32>> = (0..rows)
            .map(|_| (0..dim).map(|_| random.next_f32() * 10.0).collect())
            .collect();
        let query: Vec<f32> = (0..dim).map(|_| random.next_f32()).collect();
        let flat: Vec<f32> = vectors.iter().flatten().copied().collect();
        for &top_k in &[1_usize, 3, 100] {
            let expected = exact_cosine_search(&vectors, &query, top_k).unwrap();
            let actual = exact_cosine_search_contiguous(&flat, rows, dim, &query, top_k).unwrap();
            assert_eq!(actual, expected, "{rows}x{dim} top_k={top_k}");
        }
    }
}

#[test]
fn contiguous_rejects_a_wrong_buffer_length() {
    let err = exact_cosine_search_contiguous(&[1.0, 0.0, 2.0], 2, 2, &[1.0, 0.0], 1).unwrap_err();
    assert_eq!(
        err,
        SearchError::BufferLengthMismatch {
            rows: 2,
            dimension: 2,
            actual: 3
        }
    );
    assert_eq!(err.code(), "VECTOR_INVALID_VALUE");
}

#[test]
fn contiguous_rejects_empty_dataset_and_dimension() {
    assert_eq!(
        exact_cosine_search_contiguous(&[], 0, 2, &[1.0, 0.0], 1),
        Err(SearchError::EmptyDataset)
    );
    assert_eq!(
        exact_cosine_search_contiguous(&[], 2, 0, &[], 1),
        Err(SearchError::EmptyDimension)
    );
}

#[test]
fn contiguous_rejects_invalid_top_k() {
    assert_eq!(
        exact_cosine_search_contiguous(&[1.0, 0.0], 1, 2, &[1.0, 0.0], 0),
        Err(SearchError::InvalidTopK {
            top_k: 0,
            limit: MAX_TOP_K
        })
    );
}

#[test]
fn l2_orders_by_euclidean_distance() {
    let vectors = vec![vec![0.0, 0.0], vec![1.0, 0.0], vec![0.0, 2.0]];
    let hits = exact_search(&vectors, &[0.0, 0.0], 3, Metric::L2).unwrap();
    assert_eq!(hits.iter().map(|h| h.id).collect::<Vec<_>>(), vec![0, 1, 2]);
    assert!(hits[0].distance.abs() < 1e-6);
    assert!((hits[1].distance - 1.0).abs() < 1e-6);
    assert!((hits[2].distance - 2.0).abs() < 1e-6);
}

#[test]
fn ip_uses_negative_inner_product() {
    let vectors = vec![vec![1.0, 0.0], vec![-2.0, 0.0]];
    let hits = exact_search(&vectors, &[1.0, 0.0], 2, Metric::Ip).unwrap();
    assert_eq!(hits.iter().map(|h| h.id).collect::<Vec<_>>(), vec![0, 1]);
    assert!((hits[0].distance + 1.0).abs() < 1e-6);
    assert!((hits[1].distance - 2.0).abs() < 1e-6);
}

#[test]
fn l2_and_ip_accept_zero_vectors_but_cosine_does_not() {
    let vectors = vec![vec![0.0, 0.0], vec![1.0, 1.0]];
    assert!(exact_search(&vectors, &[0.0, 0.0], 2, Metric::L2).is_ok());
    assert!(exact_search(&vectors, &[1.0, 0.0], 2, Metric::Ip).is_ok());
    assert_eq!(
        exact_search(&vectors, &[0.0, 0.0], 2, Metric::Cosine),
        Err(SearchError::QueryZeroVector)
    );
}

#[test]
fn metric_codes_round_trip() {
    for metric in [Metric::Cosine, Metric::L2, Metric::Ip] {
        assert_eq!(Metric::from_code(metric.code()), Some(metric));
    }
    assert_eq!(Metric::from_code(3), None);
}

#[test]
fn contiguous_l2_matches_the_vec_api() {
    let vectors = vec![vec![0.0, 0.0], vec![1.0, 1.0], vec![-2.0, 0.5]];
    let flat: Vec<f32> = vectors.iter().flatten().copied().collect();
    let expected = exact_search(&vectors, &[0.0, 1.0], 3, Metric::L2).unwrap();
    let actual = exact_search_contiguous(&flat, 3, 2, &[0.0, 1.0], 3, Metric::L2).unwrap();
    assert_eq!(actual, expected);
}

/// Independent O(n log n) reference implementation used to cross-check the heap.
fn brute_force(vectors: &[Vec<f32>], query: &[f32]) -> Vec<(usize, f64)> {
    let query_norm: f64 = query.iter().map(|&x| f64::from(x) * f64::from(x)).sum();
    let mut scored: Vec<(usize, f64)> = vectors
        .iter()
        .enumerate()
        .map(|(id, vector)| {
            let mut dot = 0.0_f64;
            let mut norm = 0.0_f64;
            for (&x, &y) in vector.iter().zip(query) {
                let (x, y) = (f64::from(x), f64::from(y));
                dot += x * y;
                norm += x * x;
            }
            let similarity = dot / (norm * query_norm).sqrt();
            (id, 1.0 - similarity.clamp(-1.0, 1.0))
        })
        .collect();
    scored.sort_by(|a, b| a.1.total_cmp(&b.1).then_with(|| a.0.cmp(&b.0)));
    scored
}

/// Deterministic xorshift-style generator so tests need no external dependency.
struct Lcg(u64);

impl Lcg {
    fn new(seed: u64) -> Self {
        Self(seed.wrapping_mul(2_862_933_555_777_941_757).wrapping_add(3_037_000_493))
    }

    fn next_f32(&mut self) -> f32 {
        self.0 = self
            .0
            .wrapping_mul(6_364_136_223_846_793_005)
            .wrapping_add(1_442_695_040_888_963_407);
        let unit = (self.0 >> 40) as f32 / (1_u32 << 24) as f32;
        unit - 0.5
    }
}
