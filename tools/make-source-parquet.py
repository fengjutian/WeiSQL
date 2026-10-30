"""Generate the immutable source Parquet consumed by the Builder example and tests.

V1 Builder takes an existing Parquet file; it does not synthesise Parquet from
CSV/JSON. This script only produces that input so the fixture is reproducible.

Requires pyarrow (`pip install pyarrow`).

    python tools/make-source-parquet.py
"""

from pathlib import Path

import pyarrow as pa
import pyarrow.parquet as pq

ROWS = [
    {"id": "doc-001", "title": "DNA 结构", "category": "genetics"},
    {"id": "doc-002", "title": "RNA 转录", "category": "genetics"},
    {"id": "doc-003", "title": "细胞代谢", "category": "metabolism"},
]

SCHEMA = pa.schema(
    [
        pa.field("id", pa.string(), nullable=False),
        pa.field("title", pa.string(), nullable=False),
        pa.field("category", pa.string(), nullable=False),
    ]
)


def main() -> None:
    table = pa.Table.from_pylist(ROWS, schema=SCHEMA)
    target = Path(__file__).resolve().parents[1] / "examples" / "source" / "documents.parquet"
    target.parent.mkdir(parents=True, exist_ok=True)
    pq.write_table(
        table,
        target,
        compression="none",
        version="1.0",
        write_statistics=False,
        store_schema=True,
    )
    print(f"wrote {target} ({target.stat().st_size} bytes)")


if __name__ == "__main__":
    main()
