"""Generate a deterministic synthetic WeiSQL package for benchmarking.

The package is written directly (Parquet + Float32 + ID Map + Manifest) and then
verified with `weisql validate`, so the measurement never runs on hand-made or
inconsistent bytes. Builder is not used here on purpose: its vector input takes
in-memory arrays, and a 100k x 128 collection would be tens of millions of JS
numbers.

    python tools/bench/make-bench-package.py --output bench/pkg-100k-128 --rows 100000 --dimension 128
"""

import argparse
import hashlib
import json
from pathlib import Path

import numpy as np
import pyarrow as pa
import pyarrow.parquet as pq


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def descriptor(root: Path, relative: str) -> dict:
    path = root / relative
    return {"path": relative, "bytes": path.stat().st_size, "sha256": sha256_file(path)}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", required=True)
    parser.add_argument("--rows", type=int, default=100_000)
    parser.add_argument("--dimension", type=int, default=128)
    parser.add_argument("--seed", type=int, default=42)
    args = parser.parse_args()

    root = Path(args.output).resolve()
    (root / "data").mkdir(parents=True, exist_ok=True)
    (root / "vectors").mkdir(parents=True, exist_ok=True)

    rows, dimension = args.rows, args.dimension
    ids = [f"doc-{index:06d}" for index in range(rows)]
    categories = ["alpha", "beta", "gamma"]
    titles = [f"Document {index}" for index in range(rows)]

    # Synthetic corpus: 5000-word vocabulary drawn with a Zipf-like distribution
    # and 30-70 tokens per document, so BM25 sees realistic term frequencies,
    # document lengths and posting-list lengths instead of uniform noise.
    rng_text = np.random.default_rng(args.seed + 1)
    vocabulary = np.array([f"w{index:04d}" for index in range(5000)])
    weights = 1.0 / np.arange(1, len(vocabulary) + 1) ** 1.05
    weights = weights / weights.sum()
    bodies = []
    for _ in range(rows):
        length = int(rng_text.integers(30, 71))
        tokens = rng_text.choice(vocabulary, size=length, p=weights)
        bodies.append(" ".join(tokens.tolist()))

    table = pa.Table.from_pylist(
        [
            {"id": ids[index], "title": titles[index], "category": categories[index % len(categories)], "body": bodies[index]}
            for index in range(rows)
        ],
        schema=pa.schema(
            [
                pa.field("id", pa.string(), nullable=False),
                pa.field("title", pa.string(), nullable=False),
                pa.field("category", pa.string(), nullable=False),
                pa.field("body", pa.string(), nullable=False),
            ]
        ),
    )
    pq.write_table(table, root / "data" / "documents.parquet")

    rng = np.random.default_rng(args.seed)
    vectors = rng.standard_normal((rows, dimension), dtype=np.float32)
    # Cosine rejects zero vectors; the generator must not produce one.
    norms = np.linalg.norm(vectors, axis=1)
    zero_rows = np.flatnonzero(norms == 0.0)
    for row in zero_rows:
        vectors[row, 0] = 1.0
    vectors.astype("<f4").tofile(root / "vectors" / "embeddings.f32")

    offsets = []
    position = 0
    with (root / "vectors" / "id-map.jsonl").open("wb") as handle:
        for index, identifier in enumerate(ids):
            line = json.dumps({"row": index, "id": identifier}, separators=(",", ":")).encode("utf-8") + b"\n"
            offsets.append(position)
            position += len(line)
            handle.write(line)
    np.asarray(offsets, dtype="<u8").tofile(root / "vectors" / "id-map.offsets")

    manifest = {
        "format": "weisql",
        "formatVersion": "1.0.0",
        "datasetId": f"bench-{rows}x{dimension}",
        "tables": [
            {
                "name": "documents",
                "file": descriptor(root, "data/documents.parquet"),
                "format": "parquet",
                "columns": [
                    {"name": "id", "type": "string", "nullable": False},
                    {"name": "title", "type": "string", "nullable": False},
                    {"name": "category", "type": "string", "nullable": False},
                    {"name": "body", "type": "string", "nullable": False},
                ],
                "primaryKey": ["id"],
            }
        ],
        "vectorCollections": [
            {
                "name": "document_embeddings",
                "tableName": "documents",
                "idColumn": "id",
                "count": rows,
                "dimension": dimension,
                "metric": "cosine",
                "encoding": "f32-le-row-major",
                "data": descriptor(root, "vectors/embeddings.f32"),
                "idMap": {
                    "data": {**descriptor(root, "vectors/id-map.jsonl"), "format": "jsonl"},
                    "offsets": {**descriptor(root, "vectors/id-map.offsets"), "format": "uint64-le"},
                    "count": rows,
                    "uniqueIds": True,
                },
            }
        ],
        "metadata": {"title": f"Synthetic benchmark {rows}x{dimension}", "builderVersion": "bench-generator/1"},
    }
    (root / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"package": str(root), "rows": rows, "dimension": dimension, "vectorBytes": rows * dimension * 4}))


if __name__ == "__main__":
    main()
