//! Property-style tests over the public search API.
//!
//! Everything here is deterministic (a fixed LCG replaces a dependency on
//! `proptest`), so failures reproduce exactly. The tests target invariants that
//! a refactor or a metric change can silently break:
//!
//! - every metric agrees with an independent brute-force ordering;
//! - `top_k` results are a prefix of the full ordering;
//! - scale/shift invariances hold for cosine, L2 and inner product;
//! - extreme magnitudes stay finite instead of overflowing.

use weisql_vector_benchmark::{exact_search, exact_search_contiguous, Hit, Metric};

const METRICS: [Metric; 3] = [Metric::Cosine, Metric::L2, Metric::Ip];

#[test]
fn every_metric_matches_brute_force_on_random_shapes() {
    let mut random = Lcg::new(0x5eed);
    for &(rows, dim) in &[(1usize, 1usize), (2, 3), (17, 4), (64, 16), (32, 128)] {
        for &metric in &METRICS {
            let vectors: Vec<Vec<f32>> = (0..rows)
                .map(|_| (0..dim).map(|_| random.next_f32() * 20.0).collect())
                .collect();
            let query: Vec<f32> = (0..dim).map(|_| random.next_f32() * 5.0).collect();
            let expected = brute_force(&vectors, &query, metric);
            for &top_k in &[1_usize, 3, rows] {
                let hits = exact_search(&vectors, &query, top_k, metric).unwrap();
                let expected = &expected[..top_k.min(rows)];
                assert_eq!(hits.len(), expected.len(), "{metric:?} {rows}x{dim} k={top_k}");
                for (hit, (row, distance)) in hits.iter().zip(expected) {
                    assert_eq!(hit.id, *row, "{metric:?} {rows}x{dim} k={top_k}: rank order");
                    assert!(
                        (hit.distance - distance).abs() < 1e-5,
                        "{metric:?} {rows}x{dim} k={top_k}: {} vs {distance}",
                        hit.distance
                    );
                }
            }
        }
    }
}

#[test]
fn top_k_is_a_prefix_of_the_full_ordering() {
    let mut random = Lcg::new(99);
    let vectors: Vec<Vec<f32>> = (0..40).map(|_| (0..7).map(|_| random.next_f32()).collect()).collect();
    let query: Vec<f32> = (0..7).map(|_| random.next_f32()).collect();
    for &metric in &METRICS {
        let full = exact_search(&vectors, &query, 40, metric).unwrap();
        for &top_k in &[1_usize, 5, 39] {
            let partial = exact_search(&vectors, &query, top_k, metric).unwrap();
            assert_eq!(
                partial.iter().map(|hit| hit.id).collect::<Vec<_>>(),
                full.iter().take(top_k).map(|hit| hit.id).collect::<Vec<_>>(),
                "{metric:?} k={top_k}"
            );
        }
    }
}

#[test]
fn cosine_distance_is_scale_invariant() {
    let vectors = vec![vec![1.0_f32, 2.0, -3.0], vec![-4.0, 0.5, 1.0], vec![0.0, 1.0, 1.0]];
    let query = [1.0_f32, -1.0, 0.5];
    let scaled: Vec<Vec<f32>> = vectors
        .iter()
        .map(|row| row.iter().map(|x| x * 1e6).collect())
        .collect();
    for top_k in [1_usize, 3] {
        let base = exact_search(&vectors, &query, top_k, Metric::Cosine).unwrap();
        let scaled_hits = exact_search(&scaled, &query, top_k, Metric::Cosine).unwrap();
        for (left, right) in base.iter().zip(&scaled_hits) {
            assert_eq!(left.id, right.id);
            assert!(
                (left.distance - right.distance).abs() < 1e-5,
                "{} vs {}",
                left.distance,
                right.distance
            );
        }
    }
}

#[test]
fn l2_distance_scales_linearly_and_ip_quadratically() {
    let vectors = vec![vec![1.0_f32, -2.0], vec![3.0, 0.0], vec![-1.0, 1.0]];
    let query = [0.5_f32, 2.0];
    let scale = 4.0_f32;
    let scaled: Vec<Vec<f32>> = vectors
        .iter()
        .map(|row| row.iter().map(|x| x * scale).collect())
        .collect();
    let scaled_query: Vec<f32> = query.iter().map(|x| x * scale).collect();

    let l2 = exact_search(&vectors, &query, 3, Metric::L2).unwrap();
    let l2_scaled = exact_search(&scaled, &scaled_query, 3, Metric::L2).unwrap();
    for (left, right) in l2.iter().zip(&l2_scaled) {
        assert_eq!(left.id, right.id);
        let factor = f64::from(scale);
        assert!(
            (left.distance * factor - right.distance).abs() < 1e-4,
            "{} vs {}",
            left.distance,
            right.distance
        );
    }

    let ip = exact_search(&vectors, &query, 3, Metric::Ip).unwrap();
    let ip_scaled = exact_search(&scaled, &scaled_query, 3, Metric::Ip).unwrap();
    for (left, right) in ip.iter().zip(&ip_scaled) {
        assert_eq!(left.id, right.id);
        let factor = f64::from(scale) * f64::from(scale);
        assert!(
            (left.distance * factor - right.distance).abs() < 1e-3,
            "{} vs {}",
            left.distance,
            right.distance
        );
    }
}

#[test]
fn extreme_magnitudes_stay_finite() {
    let huge = 3.0e30_f32;
    let vectors = vec![vec![huge, -huge], vec![huge, huge], vec![f32::MIN_POSITIVE, 0.0]];
    let query = [huge, 0.0];
    for &metric in &METRICS {
        let hits = exact_search(&vectors, &query, 3, metric).unwrap();
        for hit in &hits {
            assert!(hit.distance.is_finite(), "{metric:?}: {}", hit.distance);
        }
    }
    let cosine = exact_search(&vectors, &query, 3, Metric::Cosine).unwrap();
    for hit in &cosine {
        assert!((0.0..=2.0).contains(&hit.distance), "cosine: {}", hit.distance);
    }
}

#[test]
fn contiguous_layout_agrees_for_every_metric() {
    let mut random = Lcg::new(7);
    let (rows, dim) = (23_usize, 9_usize);
    let vectors: Vec<Vec<f32>> = (0..rows)
        .map(|_| (0..dim).map(|_| random.next_f32() * 3.0).collect())
        .collect();
    let flat: Vec<f32> = vectors.iter().flatten().copied().collect();
    let query: Vec<f32> = (0..dim).map(|_| random.next_f32()).collect();
    for &metric in &METRICS {
        let from_rows: Vec<Hit> = exact_search(&vectors, &query, 7, metric).unwrap();
        let from_flat = exact_search_contiguous(&flat, rows, dim, &query, 7, metric).unwrap();
        assert_eq!(from_flat, from_rows, "{metric:?}");
    }
}

/// Independent O(n log n) reference: score everything, then sort.
fn brute_force(vectors: &[Vec<f32>], query: &[f32], metric: Metric) -> Vec<(usize, f64)> {
    let query_norm: f64 = query.iter().map(|&x| f64::from(x) * f64::from(x)).sum();
    let mut scored: Vec<(usize, f64)> = vectors
        .iter()
        .enumerate()
        .map(|(row, vector)| {
            let mut dot = 0.0_f64;
            let mut norm = 0.0_f64;
            let mut squared = 0.0_f64;
            for (&x, &y) in vector.iter().zip(query) {
                let (x, y) = (f64::from(x), f64::from(y));
                dot += x * y;
                norm += x * x;
                let difference = x - y;
                squared += difference * difference;
            }
            let distance = match metric {
                Metric::Cosine => 1.0 - (dot / (norm * query_norm).sqrt()).clamp(-1.0, 1.0),
                Metric::L2 => squared.sqrt(),
                Metric::Ip => -dot,
            };
            (row, distance)
        })
        .collect();
    scored.sort_by(|left, right| left.1.total_cmp(&right.1).then_with(|| left.0.cmp(&right.0)));
    scored
}

/// Deterministic 64-bit LCG so these tests need no external dependency.
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
