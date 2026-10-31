//! Flat C ABI over the pure-Rust HNSW fallback.
//!
//! One module instance holds one built index. The host builds it once, then runs
//! any number of searches; rebuilding replaces the previous index. Like the
//! exact WASM shim, this crate has no imports and avoids `wasm-bindgen`, so it
//! instantiates from raw bytes on any host.
//!
//! ABI version 2:
//!
//! - `weisql_hnsw_abi_version() -> u32`
//! - `weisql_hnsw_alloc(len) -> *mut u8` / `weisql_hnsw_dealloc(ptr, len)`
//! - `weisql_hnsw_build(vectors, rows, dimension, metric, m, ef_construction, ef_search, seed_lo, seed_hi) -> i32`
//! - `weisql_hnsw_search(query, top_k, out_ids, out_distances) -> i32`
//! - `weisql_hnsw_serialized_len() -> u32`, `weisql_hnsw_save(out, capacity) -> i32`
//! - `weisql_hnsw_load(bytes, len) -> i32`
//! - `weisql_hnsw_dimension() -> u32`, `weisql_hnsw_len() -> u32`
//!
//! `metric` is `0` cosine, `1` L2, `2` inner product. Distances are `f64`, ids
//! are `u32` row ids and are **approximate**: the caller must report
//! `exact: false`.

#![deny(unsafe_op_in_unsafe_fn)]

use std::alloc::{alloc, dealloc, Layout};
use std::ptr;
use std::slice;
use std::sync::Mutex;

use weisql_vector_benchmark::Metric;
use weisql_vector_hnsw::{HnswConfig, HnswError, HnswIndex};

/// Bumped whenever the exported signatures or the buffer layout change.
pub const ABI_VERSION: u32 = 2;

pub const ERROR_ARGUMENT: i32 = -1;
pub const ERROR_DATASET: i32 = -2;
pub const ERROR_NOT_BUILT: i32 = -5;

static INDEX: Mutex<Option<HnswIndex>> = Mutex::new(None);

#[no_mangle]
pub extern "C" fn weisql_hnsw_abi_version() -> u32 {
    ABI_VERSION
}

#[no_mangle]
pub extern "C" fn weisql_hnsw_alloc(len: usize) -> *mut u8 {
    if len == 0 {
        return ptr::null_mut();
    }
    let Ok(layout) = Layout::from_size_align(len, 8) else {
        return ptr::null_mut();
    };
    unsafe { alloc(layout) }
}

/// # Safety
///
/// `pointer` must come from [`weisql_hnsw_alloc`] with exactly this `len`.
#[no_mangle]
pub unsafe extern "C" fn weisql_hnsw_dealloc(pointer: *mut u8, len: usize) {
    if pointer.is_null() || len == 0 {
        return;
    }
    let Ok(layout) = Layout::from_size_align(len, 8) else {
        return;
    };
    unsafe { dealloc(pointer, layout) };
}

/// Builds the index from a row-major `f32` buffer.
///
/// # Safety
///
/// `vectors` must point to `rows * dimension` readable `f32` values that stay
/// alive for the call.
#[no_mangle]
#[allow(clippy::too_many_arguments)]
pub unsafe extern "C" fn weisql_hnsw_build(
    vectors: *const f32,
    rows: usize,
    dimension: usize,
    metric: u32,
    m: u32,
    ef_construction: u32,
    ef_search: u32,
    seed_lo: u32,
    seed_hi: u32,
) -> i32 {
    if vectors.is_null() || rows == 0 || dimension == 0 {
        return ERROR_ARGUMENT;
    }
    let Some(metric) = Metric::from_code(metric) else {
        return ERROR_ARGUMENT;
    };
    let Some(length) = rows.checked_mul(dimension) else {
        return ERROR_ARGUMENT;
    };

    // SAFETY: the caller guarantees the pointer/length contract.
    let flat = unsafe { slice::from_raw_parts(vectors, length) };
    let vectors: Vec<Vec<f32>> = flat.chunks_exact(dimension).map(<[f32]>::to_vec).collect();

    let config = HnswConfig {
        m: m as usize,
        ef_construction: ef_construction as usize,
        ef_search: ef_search as usize,
        seed: (u64::from(seed_hi) << 32) | u64::from(seed_lo),
    };
    match HnswIndex::build(vectors, metric, config) {
        Ok(index) => {
            let Ok(mut slot) = INDEX.lock() else {
                return ERROR_ARGUMENT;
            };
            *slot = Some(index);
            0
        }
        Err(error) => error_code(&error),
    }
}

/// Searches the current index.
///
/// # Safety
///
/// `query` must point to `dimension` readable `f32` values; `out_ids` must have
/// room for `top_k` `u32` values and `out_distances` for `top_k` `f64` values.
#[no_mangle]
pub unsafe extern "C" fn weisql_hnsw_search(
    query: *const f32,
    top_k: usize,
    out_ids: *mut u32,
    out_distances: *mut f64,
) -> i32 {
    if query.is_null() || out_ids.is_null() || out_distances.is_null() || top_k == 0 {
        return ERROR_ARGUMENT;
    }
    let Ok(guard) = INDEX.lock() else {
        return ERROR_ARGUMENT;
    };
    let Some(index) = guard.as_ref() else {
        return ERROR_NOT_BUILT;
    };

    // SAFETY: the caller guarantees `dimension` readable values.
    let query = unsafe { slice::from_raw_parts(query, index.dimension()) };
    match index.search(query, top_k) {
        Ok(hits) => {
            for (position, hit) in hits.iter().enumerate() {
                // SAFETY: the caller reserved `top_k` slots and `hits.len() <= top_k`.
                unsafe {
                    out_ids.add(position).write(hit.id as u32);
                    out_distances.add(position).write(hit.distance);
                }
            }
            i32::try_from(hits.len()).unwrap_or(ERROR_ARGUMENT)
        }
        Err(error) => error_code(&error),
    }
}

#[no_mangle]
pub extern "C" fn weisql_hnsw_dimension() -> u32 {
    INDEX.lock().ok().and_then(|guard| guard.as_ref().map(|index| index.dimension() as u32)).unwrap_or(0)
}

#[no_mangle]
pub extern "C" fn weisql_hnsw_len() -> u32 {
    INDEX.lock().ok().and_then(|guard| guard.as_ref().map(|index| index.len() as u32)).unwrap_or(0)
}

/// Serialized byte length of the current index, or zero when none is built.
#[no_mangle]
pub extern "C" fn weisql_hnsw_serialized_len() -> u32 {
    INDEX
        .lock()
        .ok()
        .and_then(|guard| guard.as_ref().map(|index| u32::try_from(index.to_bytes().len()).unwrap_or(0)))
        .unwrap_or(0)
}

/// Writes the serialized index into `out`.
///
/// Returns the number of bytes written, [`ERROR_ARGUMENT`] when `capacity` is
/// too small, or [`ERROR_NOT_BUILT`] when no index exists.
///
/// # Safety
///
/// `out` must point to `capacity` writable bytes.
#[no_mangle]
pub unsafe extern "C" fn weisql_hnsw_save(out: *mut u8, capacity: usize) -> i32 {
    if out.is_null() || capacity == 0 {
        return ERROR_ARGUMENT;
    }
    let Ok(guard) = INDEX.lock() else {
        return ERROR_ARGUMENT;
    };
    let Some(index) = guard.as_ref() else {
        return ERROR_NOT_BUILT;
    };
    let bytes = index.to_bytes();
    if bytes.len() > capacity {
        return ERROR_ARGUMENT;
    }
    // SAFETY: the caller guarantees `capacity` writable bytes and we just
    // checked that the payload fits.
    unsafe { ptr::copy_nonoverlapping(bytes.as_ptr(), out, bytes.len()) };
    i32::try_from(bytes.len()).unwrap_or(ERROR_ARGUMENT)
}

/// Replaces the current index with a serialized one.
///
/// Returns `0` on success, [`ERROR_ARGUMENT`] for a null/empty buffer, or
/// [`ERROR_DATASET`] when validation fails.
///
/// # Safety
///
/// `bytes` must point to `len` readable bytes.
#[no_mangle]
pub unsafe extern "C" fn weisql_hnsw_load(bytes: *const u8, len: usize) -> i32 {
    if bytes.is_null() || len == 0 {
        return ERROR_ARGUMENT;
    }
    // SAFETY: the caller guarantees `len` readable bytes.
    let serialized = unsafe { slice::from_raw_parts(bytes, len) };
    match HnswIndex::from_bytes(serialized) {
        Ok(index) => {
            let Ok(mut slot) = INDEX.lock() else {
                return ERROR_ARGUMENT;
            };
            *slot = Some(index);
            0
        }
        Err(error) => error_code(&error),
    }
}

fn error_code(error: &HnswError) -> i32 {
    match error {
        HnswError::InvalidConfig(_) | HnswError::InvalidQuery(_) => ERROR_ARGUMENT,
        HnswError::Corrupt(_) | HnswError::Build(_) => ERROR_DATASET,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Serialises tests that share the module-level index.
    static TEST_LOCK: Mutex<()> = Mutex::new(());

    fn reset() {
        if let Ok(mut slot) = INDEX.lock() {
            *slot = None;
        }
    }

    #[test]
    fn lifecycle_build_search_and_rebuild() {
        let _guard = TEST_LOCK.lock().expect("test lock");
        reset();
        let query = [1.0_f32, 0.0];
        let mut ids = [u32::MAX; 2];
        let mut distances = [f64::NAN; 2];
        let count = unsafe { weisql_hnsw_search(query.as_ptr(), 2, ids.as_mut_ptr(), distances.as_mut_ptr()) };
        assert_eq!(count, ERROR_NOT_BUILT);

        let vectors = [1.0_f32, 0.0, 0.0, 1.0, 1.0, 1.0];
        assert_eq!(unsafe { weisql_hnsw_build(vectors.as_ptr(), 3, 2, 1, 4, 16, 8, 7, 0) }, 0);
        assert_eq!(weisql_hnsw_len(), 3);
        assert_eq!(weisql_hnsw_dimension(), 2);

        let count = unsafe { weisql_hnsw_search(query.as_ptr(), 2, ids.as_mut_ptr(), distances.as_mut_ptr()) };
        assert_eq!(count, 2);
        assert_eq!(ids[0], 0);
        assert!(distances[0].abs() < 1e-9);

        // Rebuilding replaces the previous index.
        let replacement = [5.0_f32, 5.0, 9.0, 9.0];
        assert_eq!(unsafe { weisql_hnsw_build(replacement.as_ptr(), 2, 2, 2, 4, 16, 8, 1, 0) }, 0);
        assert_eq!(weisql_hnsw_len(), 2);
        assert_eq!(weisql_hnsw_dimension(), 2);
    }

    #[test]
    fn save_then_load_restores_the_index() {
        let _guard = TEST_LOCK.lock().expect("test lock");
        reset();

        let vectors = [1.0_f32, 0.0, 0.0, 1.0, 1.0, 1.0, 2.0, 2.0];
        assert_eq!(unsafe { weisql_hnsw_build(vectors.as_ptr(), 4, 2, 1, 4, 16, 8, 3, 0) }, 0);
        let query = [1.0_f32, 0.1];
        let mut ids = [u32::MAX; 3];
        let mut distances = [f64::NAN; 3];
        let before = unsafe { weisql_hnsw_search(query.as_ptr(), 3, ids.as_mut_ptr(), distances.as_mut_ptr()) };
        let expected: Vec<(u32, f64)> =
            ids[..before as usize].iter().copied().zip(distances[..before as usize].iter().copied()).collect();

        let length = weisql_hnsw_serialized_len();
        assert!(length > 0, "serialized length must be reported");
        let buffer = weisql_hnsw_alloc(length as usize);
        assert!(!buffer.is_null());
        let written = unsafe { weisql_hnsw_save(buffer, length as usize) };
        assert_eq!(written, length as i32);
        let snapshot = unsafe { slice::from_raw_parts(buffer, length as usize) }.to_vec();
        unsafe { weisql_hnsw_dealloc(buffer, length as usize) };

        // Replace the graph with a different dataset, then restore the snapshot.
        let other = [9.0_f32, 9.0, 8.0, 8.0];
        assert_eq!(unsafe { weisql_hnsw_build(other.as_ptr(), 2, 2, 2, 4, 16, 8, 1, 0) }, 0);
        assert_eq!(weisql_hnsw_len(), 2);
        assert_eq!(unsafe { weisql_hnsw_load(snapshot.as_ptr(), snapshot.len()) }, 0);
        assert_eq!(weisql_hnsw_len(), 4);
        assert_eq!(weisql_hnsw_dimension(), 2);

        let mut restored_ids = [u32::MAX; 3];
        let mut restored_distances = [f64::NAN; 3];
        let after = unsafe {
            weisql_hnsw_search(query.as_ptr(), 3, restored_ids.as_mut_ptr(), restored_distances.as_mut_ptr())
        };
        assert_eq!(after, before);
        let restored: Vec<(u32, f64)> = restored_ids[..after as usize]
            .iter()
            .copied()
            .zip(restored_distances[..after as usize].iter().copied())
            .collect();
        assert_eq!(restored, expected);
    }

    #[test]
    fn load_rejects_corrupt_bytes() {
        let _guard = TEST_LOCK.lock().expect("test lock");
        let garbage = [0_u8; 32];
        assert_eq!(unsafe { weisql_hnsw_load(garbage.as_ptr(), garbage.len()) }, ERROR_DATASET);
        assert_eq!(unsafe { weisql_hnsw_load(ptr::null(), 8) }, ERROR_ARGUMENT);
    }

    #[test]
    fn rejects_bad_arguments() {
        let vectors = [1.0_f32, 0.0];
        assert_eq!(unsafe { weisql_hnsw_build(ptr::null(), 1, 2, 1, 4, 16, 8, 0, 0) }, ERROR_ARGUMENT);
        assert_eq!(unsafe { weisql_hnsw_build(vectors.as_ptr(), 0, 2, 1, 4, 16, 8, 0, 0) }, ERROR_ARGUMENT);
        assert_eq!(unsafe { weisql_hnsw_build(vectors.as_ptr(), 1, 2, 9, 4, 16, 8, 0, 0) }, ERROR_ARGUMENT);
    }
}
