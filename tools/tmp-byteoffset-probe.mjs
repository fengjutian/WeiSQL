import { createUSearchAdapter } from "../packages/usearch-adapter/dist/index.js";
import { open } from "../packages/sdk/dist/index.js";
import { readFileSync } from "node:fs";

/** A custom reader that returns a byteOffset != 0 view (a subarray). */
class SubarrayReader {
  constructor(file) {
    this.buf = readFileSync(file);
  }
  async read() {
    return new Uint8Array(this.buf);
  }
  async readRange(_path, range) {
    return new Uint8Array(this.buf.buffer, this.buf.byteOffset + range.start, range.end - range.start);
  }
  async stat() {
    return { size: this.buf.length, supportsRange: true };
  }
  async close() {}
}

const manifest = JSON.parse(readFileSync("examples/fixture/manifest.json", "utf8"));
const reader = new SubarrayReader("examples/fixture/vectors/document_embeddings.f32");
console.log("underlying buffer byteOffset:", reader.buf.byteOffset);

try {
  const db = await open({ manifest, resourceReader: reader, vectorAdapter: createUSearchAdapter() });
  const hits = await db.vector.search("document_embeddings", [1, 0], { topK: 3 });
  console.log("RESULT ok:", JSON.stringify(hits.map((h) => h.id)));
} catch (cause) {
  console.log("RESULT threw:", cause.constructor.name, "-", cause.message);
}
