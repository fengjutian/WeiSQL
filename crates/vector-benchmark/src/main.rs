use std::time::Instant;
use weisql_vector_benchmark::exact_cosine_search;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let rows = std::env::args().nth(1).and_then(|s| s.parse::<usize>().ok()).unwrap_or(10_000);
    let dim = std::env::args().nth(2).and_then(|s| s.parse::<usize>().ok()).unwrap_or(128);
    let top_k = std::env::args().nth(3).and_then(|s| s.parse::<usize>().ok()).unwrap_or(10);
    if rows == 0 || dim == 0 || top_k == 0 {
        return Err("rows, dimension and top_k must be greater than zero".into());
    }

    // Deterministic synthetic values; this is a smoke benchmark, not a substitute
    // for a documented real-data workload or a statistically rigorous harness.
    let vectors: Vec<Vec<f32>> = (0..rows)
        .map(|row| (0..dim).map(|col| (((row * 31 + col * 17) % 997) as f32 + 1.0) / 997.0).collect())
        .collect();
    let query: Vec<f32> = (0..dim).map(|i| ((i * 13 % 101) as f32 + 1.0) / 101.0).collect();

    let start = Instant::now();
    let hits = exact_cosine_search(&vectors, &query, top_k)?;
    let elapsed = start.elapsed();
    println!("engine=exact-cosine-baseline");
    println!("rows={rows}");
    println!("dimension={dim}");
    println!("top_k={top_k}");
    println!("query_ms={:.3}", elapsed.as_secs_f64() * 1000.0);
    println!("returned={}", hits.len());
    for hit in hits {
        println!("id={} distance={:.8}", hit.id, hit.distance);
    }
    Ok(())
}
