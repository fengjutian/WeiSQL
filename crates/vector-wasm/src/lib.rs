//! Flat C ABI over the WeiSQL exact vector baseline.
//!
//! Deliberately avoids `wasm-bindgen`: the module has no imports, so any host
//! (browser, Node.js, edge worker) can instantiate it without a JS toolchain,
//! and the crate builds with `cargo build --target wasm32-unknown-unknown`
//! alone. Every `unsafe` block lives in this file and exists only to turn the
//! raw pointers the host passes in into slices.
//!
//! ABI version 2:
//!
//! - `weisql_abi_version() -> u32`
//! - `weisql_alloc(len) -> *mut u8` (8-byte aligned) / `weisql_dealloc(ptr, len)`
//! - `weisql_search_topk(vectors, rows, dimension, query, top_k, metric, out_ids, out_distances) -> i32`
//! - `weisql_cosine_topk(...)` — v1 alias for `weisql_search_topk` with `metric = 0`
//!
//! `metric` is `0` cosine, `1` L2, `2` inner product, matching
//! [`weisql_vector_benchmark::Metric::from_code`]. Every entry point returns the
//! number of hits written, or a negative error code.
//!
//! Buffer layout: `vectors` is `rows * dimension` row-major `f32` values,
//! `out_ids` takes up to `top_k` `u32` row ids and `out_distances` up to `top_k`
//! `f32` distances.

#![deny(unsafe_op_in_unsafe_fn)]

use std::alloc::{alloc, dealloc, Layout};
use std::ptr;
use std::slice;

use weisql_vector_benchmark::{exact_search_contiguous, Metric, SearchError};

/// Bumped whenever the exported signatures or the buffer layout change.
pub const ABI_VERSION: u32 = 2;

/// Null pointer, zero rows/dimension, an unknown metric, or an unaddressable buffer.
pub const ERROR_ARGUMENT: i32 = -1;
/// Empty dataset, zero vector (cosine), non-finite value, or a length mismatch.
pub const ERROR_DATASET: i32 = -2;
/// Query dimension mismatch, non-finite value, or zero vector (cosine).
pub const ERROR_QUERY: i32 = -3;
/// `top_k` outside `1..=100_000`.
pub const ERROR_TOP_K: i32 = -4;

#[no_mangle]
pub extern "C" fn weisql_abi_version() -> u32 {
    ABI_VERSION
}

/// Allocates `len` bytes inside the module memory; returns null for `len == 0`
/// or an impossible layout.
#[no_mangle]
pub extern "C" fn weisql_alloc(len: usize) -> *mut u8 {
    if len == 0 {
        return ptr::null_mut();
    }
    let Ok(layout) = Layout::from_size_align(len, 8) else {
        return ptr::null_mut();
    };
    unsafe { alloc(layout) }
}

/// Frees a pointer produced by [`weisql_alloc`] with the same `len`.
///
/// # Safety
///
/// `pointer` must come from [`weisql_alloc`] with exactly this `len`, and must
/// not be freed twice.
#[no_mangle]
pub unsafe extern "C" fn weisql_dealloc(pointer: *mut u8, len: usize) {
    if pointer.is_null() || len == 0 {
        return;
    }
    let Ok(layout) = Layout::from_size_align(len, 8) else {
        return;
    };
    unsafe { dealloc(pointer, layout) };
}

/// Cosine-only entry point kept for ABI v1 callers.
///
/// # Safety
///
/// See [`weisql_search_topk`]; the buffers have the same contracts.
#[no_mangle]
#[allow(clippy::too_many_arguments)]
pub unsafe extern "C" fn weisql_cosine_topk(
    vectors: *const f32,
    rows: usize,
    dimension: usize,
    query: *const f32,
    top_k: usize,
    out_ids: *mut u32,
    out_distances: *mut f32,
) -> i32 {
    unsafe {
        run(
            vectors,
            rows,
            dimension,
            query,
            top_k,
            Metric::Cosine,
            out_ids,
            out_distances,
        )
    }
}

/// Exact Top-K search over a contiguous row-major buffer.
///
/// Returns the number of hits written to `out_ids` / `out_distances`, or one of
/// [`ERROR_ARGUMENT`], [`ERROR_DATASET`], [`ERROR_QUERY`], [`ERROR_TOP_K`].
///
/// # Safety
///
/// - `vectors` must point to `rows * dimension` readable `f32` values.
/// - `query` must point to `dimension` readable `f32` values.
/// - `out_ids` must point to `top_k` writable `u32` slots.
/// - `out_distances` must point to `top_k` writable `f32` slots.
/// - All buffers must stay alive for the duration of the call.
#[no_mangle]
#[allow(clippy::too_many_arguments)]
pub unsafe extern "C" fn weisql_search_topk(
    vectors: *const f32,
    rows: usize,
    dimension: usize,
    query: *const f32,
    top_k: usize,
    metric: u32,
    out_ids: *mut u32,
    out_distances: *mut f32,
) -> i32 {
    let Some(metric) = Metric::from_code(metric) else {
        return ERROR_ARGUMENT;
    };
    unsafe {
        run(
            vectors,
            rows,
            dimension,
            query,
            top_k,
            metric,
            out_ids,
            out_distances,
        )
    }
}

#[allow(clippy::too_many_arguments)]
unsafe fn run(
    vectors: *const f32,
    rows: usize,
    dimension: usize,
    query: *const f32,
    top_k: usize,
    metric: Metric,
    out_ids: *mut u32,
    out_distances: *mut f32,
) -> i32 {
    if vectors.is_null() || query.is_null() || out_ids.is_null() || out_distances.is_null() {
        return ERROR_ARGUMENT;
    }
    let Some(length) = rows.checked_mul(dimension) else {
        return ERROR_ARGUMENT;
    };
    if length == 0 {
        return ERROR_ARGUMENT;
    }

    // SAFETY: the caller guarantees the pointer/length contracts above.
    let flat = unsafe { slice::from_raw_parts(vectors, length) };
    // SAFETY: same contract for the query buffer.
    let query = unsafe { slice::from_raw_parts(query, dimension) };

    match exact_search_contiguous(flat, rows, dimension, query, top_k, metric) {
        Ok(hits) => {
            for (index, hit) in hits.iter().enumerate() {
                // SAFETY: the caller reserved `top_k` slots and `hits.len() <= top_k`.
                unsafe {
                    out_ids.add(index).write(hit.id as u32);
                    out_distances.add(index).write(hit.distance);
                }
            }
            i32::try_from(hits.len()).unwrap_or(ERROR_ARGUMENT)
        }
        Err(error) => error_code(&error),
    }
}

fn error_code(error: &SearchError) -> i32 {
    match error {
        SearchError::InvalidTopK { .. } => ERROR_TOP_K,
        SearchError::DimensionMismatch { .. }
        | SearchError::QueryZeroVector
        | SearchError::QueryNonFiniteValue { .. } => ERROR_QUERY,
        _ => ERROR_DATASET,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn allocates_eight_byte_aligned_memory() {
        let pointer = weisql_alloc(64);
        assert!(!pointer.is_null());
        assert_eq!(pointer as usize % 8, 0);
        unsafe { weisql_dealloc(pointer, 64) };
    }

    #[test]
    fn allocates_nothing_for_zero_bytes() {
        assert!(weisql_alloc(0).is_null());
    }

    #[test]
    fn searches_a_flat_buffer() {
        let vectors = [1.0_f32, 0.0, 0.0, 1.0];
        let query = [1.0_f32, 0.0];
        let mut ids = [u32::MAX; 2];
        let mut distances = [f32::NAN; 2];
        let count = unsafe {
            weisql_cosine_topk(
                vectors.as_ptr(),
                2,
                2,
                query.as_ptr(),
                2,
                ids.as_mut_ptr(),
                distances.as_mut_ptr(),
            )
        };
        assert_eq!(count, 2);
        assert_eq!(ids, [0, 1]);
        assert!(distances[0].abs() < 1e-6);
        assert!((distances[1] - 1.0).abs() < 1e-6);
    }

    #[test]
    fn searches_with_the_l2_metric() {
        let vectors = [0.0_f32, 0.0, 3.0, 4.0];
        let query = [0.0_f32, 0.0];
        let mut ids = [u32::MAX; 2];
        let mut distances = [f32::NAN; 2];
        let count = unsafe {
            weisql_search_topk(
                vectors.as_ptr(),
                2,
                2,
                query.as_ptr(),
                2,
                1,
                ids.as_mut_ptr(),
                distances.as_mut_ptr(),
            )
        };
        assert_eq!(count, 2);
        assert_eq!(ids, [0, 1]);
        assert!(distances[0].abs() < 1e-6);
        assert!((distances[1] - 5.0).abs() < 1e-6);
    }

    #[test]
    fn rejects_an_unknown_metric() {
        let vectors = [1.0_f32, 0.0];
        let query = [1.0_f32, 0.0];
        let mut ids = [0_u32; 1];
        let mut distances = [0.0_f32; 1];
        let count = unsafe {
            weisql_search_topk(
                vectors.as_ptr(),
                1,
                2,
                query.as_ptr(),
                1,
                7,
                ids.as_mut_ptr(),
                distances.as_mut_ptr(),
            )
        };
        assert_eq!(count, ERROR_ARGUMENT);
    }

    #[test]
    fn rejects_null_pointers() {
        let query = [1.0_f32, 0.0];
        let mut ids = [0_u32; 1];
        let mut distances = [0.0_f32; 1];
        let count = unsafe {
            weisql_cosine_topk(
                ptr::null(),
                1,
                2,
                query.as_ptr(),
                1,
                ids.as_mut_ptr(),
                distances.as_mut_ptr(),
            )
        };
        assert_eq!(count, ERROR_ARGUMENT);
    }

    #[test]
    fn maps_search_errors_to_negative_codes() {
        let vectors = [1.0_f32, 0.0];
        let query = [1.0_f32, 0.0];
        let mut ids = [0_u32; 1];
        let mut distances = [0.0_f32; 1];
        let count = unsafe {
            weisql_cosine_topk(
                vectors.as_ptr(),
                1,
                2,
                query.as_ptr(),
                0,
                ids.as_mut_ptr(),
                distances.as_mut_ptr(),
            )
        };
        assert_eq!(count, ERROR_TOP_K);
    }
}
