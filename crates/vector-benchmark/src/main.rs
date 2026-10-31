use std::hint::black_box;
use std::time::{Duration, Instant};

use weisql_vector_benchmark::{exact_cosine_search, MAX_TOP_K};

const DEFAULT_ROWS: usize = 10_000;
const DEFAULT_DIM: usize = 128;
const DEFAULT_TOP_K: usize = 10;
const DEFAULT_ITERATIONS: usize = 5;
const WARMUP_RUNS: usize = 1;
const MAX_ITERATIONS: usize = 1_000;

fn main() {
    if let Err(error) = run() {
        eprintln!("error: {error}");
        eprintln!("usage: weisql-vector-benchmark [rows] [dimension] [top_k] [iterations]");
        std::process::exit(2);
    }
}

fn run() -> Result<(), String> {
    let mut args = std::env::args().skip(1);
    let rows = parse_arg(&mut args, "rows", DEFAULT_ROWS)?;
    let dim = parse_arg(&mut args, "dimension", DEFAULT_DIM)?;
    let top_k = parse_arg(&mut args, "top_k", DEFAULT_TOP_K)?;
    let iterations = parse_arg(&mut args, "iterations", DEFAULT_ITERATIONS)?;
    if let Some(extra) = args.next() {
        return Err(format!("unexpected argument {extra:?}"));
    }
    if rows == 0 {
        return Err("rows must be greater than zero".to_string());
    }
    if dim == 0 {
        return Err("dimension must be greater than zero".to_string());
    }
    if top_k == 0 || top_k > MAX_TOP_K {
        return Err(format!("top_k must be between 1 and {MAX_TOP_K}, got {top_k}"));
    }
    if iterations == 0 || iterations > MAX_ITERATIONS {
        return Err(format!(
            "iterations must be between 1 and {MAX_ITERATIONS}, got {iterations}"
        ));
    }

    // Deterministic synthetic values; this is a smoke benchmark, not a substitute
    // for a documented real-data workload or a statistically rigorous harness.
    let vectors: Vec<Vec<f32>> = (0..rows)
        .map(|row| {
            (0..dim)
                .map(|col| (((row * 31 + col * 17) % 997) as f32 + 1.0) / 997.0)
                .collect()
        })
        .collect();
    let query: Vec<f32> = (0..dim).map(|i| ((i * 13 % 101) as f32 + 1.0) / 101.0).collect();

    let search = || exact_cosine_search(&vectors, &query, top_k).map_err(|error| error.to_string());
    for _ in 0..WARMUP_RUNS {
        black_box(search()?);
    }

    let mut samples: Vec<Duration> = Vec::with_capacity(iterations);
    let mut last_hits = Vec::new();
    for _ in 0..iterations {
        let start = Instant::now();
        let hits = search()?;
        samples.push(start.elapsed());
        black_box(&hits);
        last_hits = hits;
    }

    let mut millis: Vec<f64> = samples.iter().map(|sample| sample.as_secs_f64() * 1000.0).collect();
    millis.sort_by(f64::total_cmp);
    let best = millis.first().copied().unwrap_or_default();
    let worst = millis.last().copied().unwrap_or_default();
    let mean = millis.iter().sum::<f64>() / millis.len() as f64;
    let median = if millis.len() % 2 == 1 {
        millis[millis.len() / 2]
    } else {
        (millis[millis.len() / 2 - 1] + millis[millis.len() / 2]) / 2.0
    };

    println!("engine=exact-cosine-baseline");
    println!("rows={rows}");
    println!("dimension={dim}");
    println!("top_k={top_k}");
    println!("iterations={iterations}");
    println!("best_ms={best:.3}");
    println!("median_ms={median:.3}");
    println!("mean_ms={mean:.3}");
    println!("worst_ms={worst:.3}");
    println!("returned={}", last_hits.len());
    for hit in last_hits {
        println!("id={} distance={:.8}", hit.id, hit.distance);
    }
    Ok(())
}

fn parse_arg(args: &mut impl Iterator<Item = String>, name: &str, default: usize) -> Result<usize, String> {
    match args.next() {
        None => Ok(default),
        Some(raw) => raw
            .parse::<usize>()
            .map_err(|_| format!("{name} must be a non-negative integer, got {raw:?}")),
    }
}
