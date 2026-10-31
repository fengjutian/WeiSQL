import { CachedResourceReader } from "/sdk/cached-resource-reader.js";
import { ContainerReader } from "/sdk/wsql-container.js";
import { open } from "/sdk/database.js";
import { HttpResourceReader } from "/sdk/http-resource-reader.js";

const $ = id => document.getElementById(id);
const setText = (id, value) => { $(id).textContent = value; };

const state = { db: undefined, reader: undefined, cache: undefined, manifest: undefined, collection: undefined, presets: [], query: undefined, mode: "directory", loadedBytes: undefined, textIndex: undefined };

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
    const stats = state.cache?.stats();
    renderDefinitionList($("diagnostics"), [
      ["mode", state.mode],
      ["results", String(hits.length)],
      ["backend", String(first?.diagnostics?.backend ?? "-")],
      ["exact", String(first?.diagnostics?.exact ?? "-")],
      ["query ms", String(elapsed)],
      ...(state.loadedBytes === undefined ? [] : [["loaded bytes", String(state.loadedBytes)]]),
      ...(stats === undefined ? [] : [["cache hits/misses", `${stats.hits}/${stats.misses}`], ["coalesced", String(stats.coalesced)], ["bytes read", String(stats.bytesRead)], ["cached entries", String(stats.entries)]]),
    ]);
    setText("status", `${hits.length} 条结果 · ${elapsed} ms`);
    window.__PLAYGROUND_STATE = {
      ...(window.__PLAYGROUND_STATE ?? {}),
      ok: true,
      mode: state.mode,
      ...(state.loadedBytes === undefined ? {} : { loadedBytes: state.loadedBytes }),
      ids: hits.map(hit => hit.id),
      distances: hits.map(hit => Number(hit.distance.toFixed(6))),
    };
  } catch (error) {
    setText("status", "失败");
    setText("error", String(error && error.message ? error.message : error));
    window.__PLAYGROUND_STATE = { ok: false, error: String(error) };
  }
}

async function textSearch() {
  if (state.textIndex === undefined) return;
  setText("text-status", "检索中…");
  setText("error", "");
  try {
    const started = performance.now();
    const hits = await state.db.text.search(state.textIndex.name, $("text-query").value, { topK: Number($("topk").value) });
    const elapsed = Math.round(performance.now() - started);
    const body = $("text-results");
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
      for (const value of [hit.row, hit.id, hit.score.toFixed(4)]) {
        const cell = document.createElement("td");
        cell.textContent = String(value);
        row.append(cell);
      }
      body.append(row);
    }
    setText("text-status", `${hits.length} 条结果 · ${elapsed} ms · ${hits[0]?.diagnostics?.backend ?? "-"}`);
    window.__PLAYGROUND_STATE = { ...(window.__PLAYGROUND_STATE ?? {}), ok: true, textIds: hits.map(hit => hit.id), textScores: hits.map(hit => Number(hit.score.toFixed(6))) };
  } catch (error) {
    setText("text-status", "失败");
    setText("error", String(error && error.message ? error.message : error));
  }
}

async function assembleEvidence() {
  if (state.textIndex === undefined) return;
  setText("rag-status", "组装中…");
  setText("error", "");
  try {
    const result = await state.db.rag.search({
      text: { name: state.textIndex.name, query: $("text-query").value },
      topK: 3,
      maxCharacters: 200,
    });
    const list = $("rag-evidence");
    list.replaceChildren();
    for (const evidence of result.evidences) {
      const item = document.createElement("li");
      const head = document.createElement("code");
      head.textContent = `${evidence.id} · rank ${evidence.rank} · ${evidence.characters} chars${evidence.truncated ? " · 已截断" : ""}`;
      const text = document.createElement("div");
      text.textContent = evidence.text;
      item.append(head, text);
      list.append(item);
    }
    setText("rag-status", `${result.evidences.length} 条证据 · ${result.usedCharacters}/${result.diagnostics.maxCharacters} 字符${result.truncated ? " · 已截断" : ""}`);
    window.__PLAYGROUND_STATE = {
      ...(window.__PLAYGROUND_STATE ?? {}),
      ok: true,
      ragIds: result.evidences.map(evidence => evidence.id),
      ragTexts: result.evidences.map(evidence => evidence.text),
    };
  } catch (error) {
    setText("rag-status", "失败");
    setText("error", String(error && error.message ? error.message : error));
  }
}

async function readDirectory() {
  const base = new URL("/fixture/", location.href).href;
  const cache = new CachedResourceReader({
    reader: new HttpResourceReader({ baseUrl: base }),
    maxCacheBytes: 1024 * 1024,
    version: "playground",
  });
  const manifest = await (await fetch(new URL("manifest.json", base))).json();
  const db = await open({ manifest, resourceReader: cache, verifyChecksums: "all" });
  return { db, reader: cache, cache, manifest, mode: "directory", loadedBytes: undefined };
}

/** Fetches the whole `.wsql` container once and serves everything from memory. */
async function readContainer() {
  const response = await fetch("/container.wsql");
  if (!response.ok) throw new Error(`container.wsql returned ${response.status}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  const reader = new ContainerReader(bytes);
  const manifest = JSON.parse(new TextDecoder().decode(await reader.read("manifest.json")));
  const db = await open({ manifest, resourceReader: reader, verifyChecksums: "all" });
  return { db, reader, cache: undefined, manifest, mode: "container", loadedBytes: bytes.byteLength };
}

async function activate(mode) {
  setText("error", "");
  setText("status", "加载中…");
  for (const id of ["mode-directory", "mode-container"]) $(id).disabled = true;
  try {
    if (state.db !== undefined) await state.db.close();
    const loaded = mode === "container" ? await readContainer() : await readDirectory();
    Object.assign(state, loaded);
    state.collection = loaded.manifest.vectorCollections[0];
    state.textIndex = loaded.manifest.textIndexes?.[0];
    $("mode-directory").setAttribute("aria-pressed", String(mode === "directory"));
    $("mode-container").setAttribute("aria-pressed", String(mode === "container"));

    renderDefinitionList($("package-info"), [
      ["dataset", loaded.manifest.datasetId],
      ["tables", loaded.manifest.tables.map(table => `${table.name} (${table.columns.length} columns)`).join(", ")],
      ["vectors", `${state.collection.name} · ${state.collection.count} rows · dimension ${state.collection.dimension} · ${state.collection.metric}`],
      ["text index", state.textIndex === undefined ? "none" : `${state.textIndex.name} · ${state.textIndex.termCount} terms · column ${state.textIndex.column}`],
      ["format", `${loaded.manifest.format} ${loaded.manifest.formatVersion}`],
      ["state", loaded.db.state],
      ["capabilities", Object.entries(loaded.db.capabilities()).map(([key, value]) => `${key}=${value}`).join(" ")],
    ]);

    state.presets = await readPresets(loaded.reader, state.collection, 3);
    state.query = state.presets[0];
    renderPresets();

    $("text-search").disabled = state.textIndex === undefined;
    $("rag").disabled = state.textIndex === undefined;
    setText("text-note", state.textIndex === undefined
      ? "此数据包未声明全文索引，无法演示 BM25 与 RAG。"
      : "分数越大越相关，与向量距离方向相反。");

    await search();
    if (state.textIndex !== undefined) await textSearch();
    window.__PLAYGROUND_STATE = { ...(window.__PLAYGROUND_STATE ?? {}), ok: true, mode: state.mode };
    window.__PLAYGROUND_READY = true;
    setText("status", "就绪");
  } catch (error) {
    setText("status", "加载失败");
    setText("error", String(error && error.message ? error.message : error));
    window.__PLAYGROUND_STATE = { ok: false, error: String(error) };
  } finally {
    for (const id of ["mode-directory", "mode-container"]) $(id).disabled = false;
  }
}

async function main() {
  $("mode-directory").addEventListener("click", () => void activate("directory"));
  $("mode-container").addEventListener("click", () => void activate("container"));
  $("search").addEventListener("click", () => void search());
  $("text-search").addEventListener("click", () => void textSearch());
  $("rag").addEventListener("click", () => void assembleEvidence());
  await activate("directory");
}

main().catch(error => {
  setText("status", "初始化失败");
  setText("error", String(error && error.stack ? error.stack : error));
  window.__PLAYGROUND_READY = false;
  window.__PLAYGROUND_STATE = { ok: false, error: String(error) };
});
