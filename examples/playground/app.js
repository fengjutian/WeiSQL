import { CachedResourceReader } from "/sdk/cached-resource-reader.js";
import { open } from "/sdk/database.js";
import { HttpResourceReader } from "/sdk/http-resource-reader.js";

const $ = id => document.getElementById(id);
const setText = (id, value) => { $(id).textContent = value; };

const state = { db: undefined, cache: undefined, manifest: undefined, collection: undefined, presets: [], query: undefined };

function renderDefinitionList(element, entries) {
  element.replaceChildren();
  for (const [term, description] of entries) {
    const dt = document.createElement("dt");
    dt.textContent = term;
    const dd = document.createElement("dd");
    dd.textContent = description;
    element.append(dt, dd);
  }
}

/** Reads the first vectors straight from the package so presets are real data, not hard-coded. */
async function readPresets(reader, collection, count) {
  const bytes = await reader.readRange(collection.data.path, {
    start: 0,
    end: Math.min(count, collection.count) * collection.dimension * 4,
  });
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const presets = [];
  for (let row = 0; row < Math.min(count, collection.count); row++) {
    const vector = new Float32Array(collection.dimension);
    for (let i = 0; i < collection.dimension; i++) vector[i] = view.getFloat32((row * collection.dimension + i) * 4, true);
    presets.push({ row, vector });
  }
  return presets;
}

function formatVector(vector) {
  // Float32 values carry decimal noise (0.9 reads back as 0.8999999761); show a
  // readable form without pretending the stored value is exact decimal.
  return [...vector].map(value => Number(value.toFixed(4))).join(", ");
}

function renderPresets() {
  const container = $("presets");
  container.replaceChildren();
  state.presets.forEach(preset => {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = `row ${preset.row} · [${formatVector(preset.vector)}]`;
    button.setAttribute("aria-pressed", String(state.query === preset));
    button.addEventListener("click", () => {
      state.query = preset;
      renderPresets();
      void search();
    });
    container.append(button);
  });
}

async function search() {
  const topK = Number($("topk").value);
  setText("error", "");
  setText("status", "检索中…");
  try {
    const started = performance.now();
    const hits = await state.db.vector.search(state.collection.name, state.query.vector, { topK });
    const elapsed = Math.round(performance.now() - started);
    const body = $("results");
    body.replaceChildren();
    if (hits.length === 0) {
      const row = document.createElement("tr");
      const cell = document.createElement("td");
      cell.colSpan = 3;
      cell.className = "muted";
      cell.textContent = "没有命中";
      row.append(cell);
      body.append(row);
    }
    for (const hit of hits) {
      const row = document.createElement("tr");
      for (const value of [hit.row, hit.id, hit.distance.toFixed(6)]) {
        const cell = document.createElement("td");
        cell.textContent = String(value);
        row.append(cell);
      }
      body.append(row);
    }
    const first = hits[0];
    const stats = state.cache.stats();
    renderDefinitionList($("diagnostics"), [
      ["results", String(hits.length)],
      ["backend", String(first?.diagnostics?.backend ?? "-")],
      ["exact", String(first?.diagnostics?.exact ?? "-")],
      ["query ms", String(elapsed)],
      ["cache hits/misses", `${stats.hits}/${stats.misses}`],
      ["coalesced", String(stats.coalesced)],
      ["bytes read", String(stats.bytesRead)],
      ["cached entries", String(stats.entries)],
    ]);
    setText("status", `${hits.length} 条结果 · ${elapsed} ms`);
    window.__PLAYGROUND_STATE = { ok: true, ids: hits.map(hit => hit.id), distances: hits.map(hit => Number(hit.distance.toFixed(6))) };
  } catch (error) {
    setText("status", "失败");
    setText("error", String(error && error.message ? error.message : error));
    window.__PLAYGROUND_STATE = { ok: false, error: String(error) };
  }
}

async function main() {
  const base = new URL("/fixture/", location.href).href;
  const cache = new CachedResourceReader({
    reader: new HttpResourceReader({ baseUrl: base }),
    maxCacheBytes: 1024 * 1024,
    version: "playground",
  });
  state.cache = cache;

  const manifest = await (await fetch(new URL("manifest.json", base))).json();
  state.manifest = manifest;
  const db = await open({ manifest, resourceReader: cache, verifyChecksums: "all" });
  state.db = db;

  const collection = manifest.vectorCollections[0];
  state.collection = collection;

  renderDefinitionList($("package-info"), [
    ["dataset", manifest.datasetId],
    ["tables", manifest.tables.map(table => `${table.name} (${table.columns.length} columns)`).join(", ")],
    ["vectors", `${collection.name} · ${collection.count} rows · dimension ${collection.dimension} · ${collection.metric}`],
    ["format", `${manifest.format} ${manifest.formatVersion}`],
    ["state", db.state],
    ["capabilities", Object.entries(db.capabilities()).map(([key, value]) => `${key}=${value}`).join(" ")],
  ]);

  state.presets = await readPresets(cache, collection, 3);
  state.query = state.presets[0];
  renderPresets();

  $("search").addEventListener("click", () => void search());
  await search();

  window.__PLAYGROUND_READY = true;
  setText("status", "就绪");
}

main().catch(error => {
  setText("status", "初始化失败");
  setText("error", String(error && error.stack ? error.stack : error));
  window.__PLAYGROUND_READY = false;
  window.__PLAYGROUND_STATE = { ok: false, error: String(error) };
});
