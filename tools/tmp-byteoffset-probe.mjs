import { createUSearchAdapter } from "../packages/usearch-adapter/dist/index.js";
import { open } from "../packages/sdk/dist/index.js";
import { readFileSync } from "node:fs";

const FIXTURE = "examples/fixture";
const manifest = JSON.parse(readFileSync(`${FIXTURE}/manifest.json`, "utf8"));

/**
 * Reader that returns a byteOffset != 0 view. The vector path starts at a
 * multiple of 4 in the file, so the view stays 4-aligned only if the base
 * buffer is. `skew` shifts the base buffer to control alignment.
 */
class SkewedReader {
  constructor(skew) {
    this.skew = skew;
    this.files = new Map();
  }
  load(path) {
    if (!this.files.has(path)) this.files.set(path, readFileSync(`${FIXTURE}/${path}`));
    return this.files.get(path);
  }
  async read(path) {
    const buf = this.load(path);
    const backing = Buffer.alloc(this.skew + buf.length);
    buf.copy(backing, this.skew);
    return new Uint8Array(backing.buffer, this.skew, buf.length);
  }
  async readRange(path, range) {
    const buf = this.load(path);
    const backing = Buffer.alloc(this.skew + buf.length);
    buf.copy(backing, this.skew);
    return new Uint8Array(backing.buffer, this.skew + range.start, range.end - range.start);
  }
  async stat(path) {
    return { size: this.load(path).length, supportsRange: true };
  }
  async close() {}
}

for (const skew of [0, 1]) {
  const reader = new SkewedReader(skew);
  const label = `skew=${skew} (base byteOffset ${skew})`;
  try {
    const db = await open({ manifest, resourceReader: reader, vectorAdapter: createUSearchAdapter() });
    const hits = await db.vector.search("document_embeddings", [1, 0], { topK: 3 });
    console.log(`ANN  ${label}: ok ${JSON.stringify(hits.map((h) => h.id))}`);
  } catch (cause) {
    console.log(`ANN  ${label}: ${cause.constructor.name} - ${cause.message}`);
  }
  try {
    const db = await open({ manifest, resourceReader: new SkewedReader(skew) });
    const hits = await db.vector.search("document_embeddings", [1, 0], { topK: 3 });
    console.log(`EXACT ${label}: ok ${JSON.stringify(hits.map((h) => h.id))}`);
  } catch (cause) {
    console.log(`EXACT ${label}: ${cause.constructor.name} - ${cause.message}`);
  }
}
