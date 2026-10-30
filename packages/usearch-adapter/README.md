# @weisql/usearch-adapter

Approximate (HNSW) `VectorAdapter` for WeiSQL AI, backed by
[USearch](https://github.com/unum-cloud/usearch). The SDK keeps exact search as
its default; this package is injected when approximate search is wanted.

```ts
import { open, NodeFileResourceReader } from "@weisql/sdk";
import { createUSearchAdapter } from "@weisql/usearch-adapter";

const db = await open({
  manifestUrl: "./demo/manifest.json",
  resourceReader: new NodeFileResourceReader({ rootDirectory: "./demo" }),
  vectorAdapter: createUSearchAdapter({ expansionSearch: 512 }),
});

const hits = await db.vector.search("document_embeddings", query, { topK: 10 });
// hits[i].diagnostics → { backend: "usearch-hnsw", exact: false }
```

## Honest capabilities

- `exactSearch: false` — results are approximate and every hit says so.
- `persistedIndex: true` — if the Manifest declares an index, it is loaded;
  otherwise the index is built on the first search.
- `metadataFiltering: false` — filtered queries are refused (`SQL_UNSUPPORTED`)
  rather than post-filtered, because a candidate window cannot produce the
  filtered nearest K.
- `cancellation: "unsupported"` — the signal is checked between index-build
  batches; a running search cannot be interrupted.

## Recall is a parameter, not a guarantee

`expansionSearch` defaults to 512. On a synthetic 100k × 128 uniform dataset it
measured Recall@10 ≈ 0.735 (min 0.400 per query) at ~22 ms p50, versus exact
search at ~213 ms with recall 1.0. Uniform random vectors are the worst case for
HNSW, so these numbers do not predict real embeddings — measure your own data:

```bash
npm run bench -- --ann --expansion-search 512
```

Details: [`docs/USEARCH_ADAPTER.md`](../../docs/USEARCH_ADAPTER.md),
[`docs/BENCHMARK_HARNESS.md`](../../docs/BENCHMARK_HARNESS.md).

## Requirements

Node.js 22+ (USearch ships prebuilt binaries for common platforms).
