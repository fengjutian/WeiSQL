//! Serialization tests: a graph must survive a byte round trip unchanged, and
//! every corrupted buffer must be rejected rather than loaded as a broken graph.

use weisql_vector_benchmark::Metric;
use weisql_vector_hnsw::{HnswConfig, HnswError, HnswIndex};

fn vectors(count: usize, dimension: usize, seed: u64) -> Vec<Vec<f32>> {
    let mut state = seed;
    (0..count)
        .map(|_| {
            (0..dimension)
                .map(|_| {
                    state = state.wrapping_mul(6_364_136_223_846_793_005).wrapping_add(1_442_695_040_888_963_407);
                    ((state >> 40) as f32) / ((1_u32 << 24) as f32) - 0.5
                })
                .collect()
        })
        .collect()
}

fn config() -> HnswConfig {
    HnswConfig { m: 8, ef_construction: 80, ef_search: 48, seed: 5 }
}

fn fnv1a(bytes: &[u8]) -> u64 {
    let mut hash = 0xcbf2_9ce4_8422_2325_u64;
    for &byte in bytes {
        hash ^= u64::from(byte);
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    hash
}

/// Rewrites the trailing checksum so a mutation reaches a structural check.
fn resign(bytes: &mut [u8]) {
    let split = bytes.len() - 8;
    let checksum = fnv1a(&bytes[..split]);
    bytes[split..].copy_from_slice(&checksum.to_le_bytes());
}

#[test]
fn round_trip_preserves_results() {
    let vectors = vectors(300, 12, 1);
    let index = HnswIndex::build(vectors.clone(), Metric::L2, config()).unwrap();
    let bytes = index.to_bytes();
    let restored = HnswIndex::from_bytes(&bytes).unwrap();

    assert_eq!(restored.len(), index.len());
    assert_eq!(restored.dimension(), index.dimension());
    assert_eq!(restored.metric(), index.metric());
    assert_eq!(restored.to_bytes(), bytes, "serialization must be deterministic");

    for query in vectors.iter().take(25) {
        let expected = index.search(query, 10).unwrap();
        let actual = restored.search(query, 10).unwrap();
        assert_eq!(actual, expected, "restored graph returned different hits");
    }
}

#[test]
fn round_trip_works_for_every_metric() {
    let data = vectors(120, 8, 2);
    for metric in [Metric::Cosine, Metric::L2, Metric::Ip] {
        let index = HnswIndex::build(data.clone(), metric, config()).unwrap();
        let restored = HnswIndex::from_bytes(&index.to_bytes()).unwrap();
        assert_eq!(restored.metric(), metric);
        assert_eq!(restored.search(&data[3], 5).unwrap(), index.search(&data[3], 5).unwrap());
    }
}

#[test]
fn rejects_truncated_buffers() {
    let index = HnswIndex::build(vectors(50, 6, 3), Metric::L2, config()).unwrap();
    let bytes = index.to_bytes();
    for length in [0_usize, 1, 4, bytes.len() / 2, bytes.len() - 1] {
        let error = HnswIndex::from_bytes(&bytes[..length]).unwrap_err();
        assert_eq!(error.code(), "RESOURCE_INTEGRITY_FAILED", "length {length}");
    }
}

#[test]
fn rejects_a_tampered_checksum() {
    let index = HnswIndex::build(vectors(50, 6, 4), Metric::L2, config()).unwrap();
    let mut bytes = index.to_bytes();
    let last = bytes.len() - 1;
    bytes[last] ^= 0xff;
    assert_eq!(HnswIndex::from_bytes(&bytes).unwrap_err(), HnswError::Corrupt("checksum mismatch"));
}

#[test]
fn rejects_bad_magic_and_version_after_resigning() {
    let index = HnswIndex::build(vectors(20, 4, 5), Metric::L2, config()).unwrap();
    let original = index.to_bytes();

    let mut wrong_magic = original.clone();
    wrong_magic[0] = b'X';
    resign(&mut wrong_magic);
    assert_eq!(HnswIndex::from_bytes(&wrong_magic).unwrap_err(), HnswError::Corrupt("bad magic"));

    let mut wrong_version = original.clone();
    wrong_version[8..12].copy_from_slice(&99_u32.to_le_bytes());
    resign(&mut wrong_version);
    assert_eq!(HnswIndex::from_bytes(&wrong_version).unwrap_err(), HnswError::Corrupt("unsupported format version"));

    let mut wrong_metric = original;
    wrong_metric[16..20].copy_from_slice(&9_u32.to_le_bytes());
    resign(&mut wrong_metric);
    assert_eq!(HnswIndex::from_bytes(&wrong_metric).unwrap_err(), HnswError::Corrupt("unknown metric"));
}

#[test]
fn rejects_an_empty_index() {
    assert_eq!(HnswIndex::from_bytes(&[]).unwrap_err(), HnswError::Corrupt("index is shorter than its checksum"));
}
