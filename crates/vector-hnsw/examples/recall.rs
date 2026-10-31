//! Small HNSW harness: build time, query latency and Recall@10 against the
//! exact baseline on deterministic clustered data.
//!
//! ```text
//! cargo run --release --example recall
//! ```

use std::time::Instant;

use weisql_vector_benchmark::{exact_search, Metric};
use weisql_vector_hnsw::{HnswConfig, HnswIndex};

const COUNT: usize = 2_000;
const DIMENSION: usize = 32;
const CLUSTERS: usize = 8;
const TOP_K: usize = 10;
const QUERIES: usize = 100;

fn main() {
    let vectors = clustered(COUNT, DIMENSION, CLUSTERS, 7);

    let start = Instant::now();
    let index = HnswIndex::build(
        vectors.clone(),
        Metric::L2,
        HnswConfig { m: 16, ef_construction: 200, ef_search: 64, seed: 7 },
    )
    .expect("build");
    let build_ms = start.elapsed().as_secs_f64() * 1000.0;

    let mut hits = 0;
    let mut total = 0;
    let mut query_ms = Vec::with_capacity(QUERIES);
    for query in vectors.iter().take(QUERIES) {
        let expected = exact_search(&vectors, query, TOP_K, Metric::L2).expect("exact");
        let start = Instant::now();
        let actual = index.search(query, TOP_K).expect("hnsw");
        query_ms.push(start.elapsed().as_secs_f64() * 1000.0);
        let expected_ids: Vec<usize> = expected.iter().map(|hit| hit.id).collect();
        for hit in &actual {
            if expected_ids.contains(&hit.id) {
                hits += 1;
            }
        }
        total += expected_ids.len();
    }
    query_ms.sort_by(f64::total_cmp);

    println!("engine=weisql-hnsw");
    println!("rows={COUNT}");
    println!("dimension={DIMENSION}");
    println!("metric=l2");
    println!("top_k={TOP_K}");
    println!("build_ms={build_ms:.2}");
    println!("p50_query_ms={:.4}", query_ms[query_ms.len() / 2]);
    println!("best_query_ms={:.4}", query_ms[0]);
    println!("recall_at_k={:.4}", hits as f64 / total as f64);
    println!("links_layer0={} links_upper={}", index.link_counts().0, index.link_counts().1);
}

fn clustered(count: usize, dimension: usize, clusters: usize, seed: u64) -> Vec<Vec<f32>> {
    let mut rng = Lcg(seed);
    let centers: Vec<Vec<f32>> =
        (0..clusters).map(|_| (0..dimension).map(|_| rng.next_f32() * 20.0).collect()).collect();
    (0..count)
        .map(|_| {
            let center = &centers[(rng.next_u64() % clusters as u64) as usize];
            (0..dimension).map(|column| center[column] + rng.next_f32() * 0.5).collect()
        })
        .collect()
}

struct Lcg(u64);

impl Lcg {
    fn next_u64(&mut self) -> u64 {
        self.0 = self.0.wrapping_mul(6_364_136_223_846_793_005).wrapping_add(1_442_695_040_888_963_407);
        self.0
    }

    fn next_f32(&mut self) -> f32 {
        ((self.next_u64() >> 40) as f32) / ((1_u32 << 24) as f32) - 0.5
    }
}
