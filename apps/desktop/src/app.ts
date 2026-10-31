import {
  open,
  StreamingContainerReader,
} from "@weisql/sdk";
import type {
  ResourceReader,
  SqlAdapter,
  TextHit,
  VectorHit,
  WeiSQLDatabase,
  WeiSQLManifest,
} from "@weisql/sdk";

import { isTauriRuntime, TauriBackend } from "./backend.js";
import { createSqlAdapter } from "./duckdb.js";
import { clear, el, errorText, formatBytes, formatValue, mustGet, renderPairs, setStatus } from "./dom.js";
import { BackendContainerSource, BackendDirectoryReader, CountingReader, SampleReader } from "./readers.js";

declare global {
  interface Window {
    __DESKTOP_STATE?: Record<string, unknown>;
  }
}

type Mode = "directory" | "container" | "sample";

interface Source {
  mode: Mode;
  path?: string;
  displayPath: string;
}

interface Session extends Source {
  manifest: Readonly<WeiSQLManifest>;
  db: WeiSQLDatabase;
  reader: CountingReader;
  sql?: { db: WeiSQLDatabase; reader: ResourceReader };
}

interface VectorPreset {
  row: number;
  values: number[];
}

const backend = isTauriRuntime() ? new TauriBackend() : undefined;
let session: Session | undefined;
let presets: VectorPreset[] = [];
let busy = false;

export async function start(): Promise<void> {
  wireTabs();
  wireOpenButtons();
  wireSql();
  wireVector();
  wireText();

  const badge = mustGet("backend-badge");
  badge.textContent = backend === undefined ? "浏览器预览 · 内置示例" : "Tauri · 本机文件";

  if (backend === undefined) {
    for (const id of ["open-directory", "open-container", "empty-open-container"]) {
      const button = document.getElementById(id);
      if (button !== null) button.hidden = true;
    }
    mustGet("empty-open-directory").textContent = "打开示例数据包";
  }

  setStatus("就绪");
  renderDiagnostics();

  // The browser preview has no file dialog, so it opens the bundled example.
  if (backend === undefined) await loadPackage({ mode: "sample", displayPath: "示例数据包（内置）" });
}

/** Entry point for the Tauri drag-and-drop handler. */
export async function openPath(path: string): Promise<void> {
  const kind = await backend?.stat(path).catch(() => undefined);
  await loadPackage({
    mode: kind?.isDirectory === true ? "directory" : "container",
    path,
    displayPath: path,
  });
}

async function chooseDirectory(): Promise<void> {
  if (backend === undefined) return openSample();
  const path = await backend.pickDirectory();
  if (path !== undefined) await openPath(path);
}

async function chooseContainer(): Promise<void> {
  if (backend === undefined) return openSample();
  const path = await backend.pickContainer();
  if (path !== undefined) await openPath(path);
}

async function openSample(): Promise<void> {
  await loadPackage({ mode: "sample", displayPath: "示例数据包（内置）" });
}

async function loadPackage(source: Source): Promise<void> {
  if (busy) return;
  busy = true;
  setBusy(true);
  setStatus("正在打开数据包…");
  hideOpenError();
  try {
    const previous = session;
    session = undefined;
    if (previous !== undefined) await dispose(previous);

    const reader = new CountingReader(await createReader(source));
    const manifestBytes = await reader.read("manifest.json");
    let manifestJson: unknown;
    try {
      manifestJson = JSON.parse(new TextDecoder().decode(manifestBytes));
    } catch {
      throw new Error("manifest.json 不是合法的 JSON");
    }

    const db = await open({
      manifest: manifestJson as WeiSQLManifest,
      resourceReader: reader,
      // Small packages: hash every declared resource up front. This is the same
      // L3 check the CLI runs, so a truncated download fails here, not in a query.
      verifyChecksums: "all",
    });

    session = { ...source, manifest: db.manifest, db, reader };
    presets = [];
    renderSession();
    setStatus(`已打开 ${db.manifest.datasetId} · ${formatBytes(reader.stats.bytes)} 已校验`);
    publish({ ok: true, datasetId: db.manifest.datasetId, mode: source.mode, path: source.displayPath });
    void loadPresets().catch(() => undefined);
  } catch (error) {
    session = undefined;
    renderEmptyState();
    showOpenError(errorText(error));
    setStatus(`打开失败：${errorText(error)}`);
    publish({ ok: false, error: errorText(error) });
  } finally {
    busy = false;
    setBusy(false);
    renderDiagnostics();
  }
}

async function createReader(source: Source): Promise<ResourceReader> {
  if (source.mode === "sample") return new SampleReader();
  if (backend === undefined || source.path === undefined) throw new Error("桌面后端不可用");
  if (source.mode === "directory") return new BackendDirectoryReader(backend, source.path);
  return StreamingContainerReader.open(new BackendContainerSource(backend, source.path));
}

async function createReaderFor(current: Session): Promise<ResourceReader> {
  return createReader(current);
}

async function dispose(current: Session): Promise<void> {
  if (current.sql !== undefined) {
    try {
      await current.sql.db.close();
    } catch {
      // A failed close must not keep the next package from opening.
    }
  }
  try {
    await current.db.close();
  } catch {
    // Ignore: the runtime may already be closed after an error.
  }
  try {
    await current.reader.close();
  } catch {
    // Nothing to release.
  }
}

function setBusy(value: boolean): void {
  for (const id of ["open-directory", "open-container", "open-sample", "empty-open-directory", "empty-open-container", "empty-open-sample"]) {
    const button = document.getElementById(id);
    if (button instanceof HTMLButtonElement) button.disabled = value;
  }
}

function renderEmptyState(): void {
  mustGet("overview-empty").hidden = false;
  mustGet("overview-content").hidden = true;
  mustGet("package-path").textContent = "尚未打开数据包";
  mustGet("package-path").title = "尚未打开数据包";
  renderPairs(mustGet("package-info"), []);
  renderPairs(mustGet("capabilities"), []);
  setIntegrity("unknown");
  clear(mustGet("tables"));
  clear(mustGet("vectors"));
  clear(mustGet("text-indexes"));
}

function renderSession(): void {
  const current = session;
  if (current === undefined) return renderEmptyState();
  const manifest = current.manifest;

  mustGet("overview-empty").hidden = true;
  mustGet("overview-content").hidden = false;
  const pathElement = mustGet("package-path");
  pathElement.textContent = current.displayPath;
  pathElement.title = current.displayPath;

  renderPairs(mustGet("package-info"), [
    ["dataset", manifest.datasetId],
    ["格式", `${manifest.format} ${manifest.formatVersion}`],
    ["模式", current.mode === "directory" ? "目录（按需读取）" : current.mode === "container" ? "单文件 .wsql（流式）" : "内置示例"],
    ["表", manifest.tables.map(table => table.name).join(", ")],
    ["向量", manifest.vectorCollections.map(vector => `${vector.name} · ${vector.count}×${vector.dimension} · ${vector.metric}`).join("；") || "无"],
    ["全文索引", manifest.textIndexes?.map(index => `${index.name} · ${index.termCount} terms`).join("；") || "无"],
    ["标题", manifest.metadata?.title ?? "—"],
    ["创建时间", manifest.metadata?.createdAt ?? "—"],
  ]);

  setIntegrity("ok");
  renderCapabilities(current);
  renderTables(manifest);
  renderVectorCollections(manifest);
  renderTextIndexes(manifest);
  populateSelects(manifest);
  renderDiagnostics();
}

function renderCapabilities(current: Session): void {
  const capabilities = current.db.capabilities();
  const pairs: [string, string][] = [
    ["SQL", "按需加载"],
    ["精确向量检索", capabilities.vectorExactSearch ? "支持" : "无"],
    ["全文检索", capabilities.textSearch ? "支持" : "无"],
    ["RRF 融合", capabilities.fusionSearch ? "支持" : "无"],
    ["RAG 证据", capabilities.ragSearch ? "支持" : "无"],
  ];
  renderPairs(mustGet("capabilities"), pairs);
}

function setIntegrity(state: "unknown" | "ok" | "bad", detail?: string): void {
  const element = mustGet("integrity");
  element.className = `integrity ${state === "unknown" ? "muted" : state}`;
  clear(element);
  element.append(el("span", { class: "dot" }));
  const text = state === "ok" ? "SHA-256 已校验（尺寸 + 摘要）" : state === "bad" ? "校验失败" : "未校验";
  element.append(el("span", { text: detail ?? text }));
}

function renderTables(manifest: Readonly<WeiSQLManifest>): void {
  const container = mustGet("tables");
  clear(container);
  mustGet("table-count").textContent = `${manifest.tables.length} 张表`;

  for (const table of manifest.tables) {
    const card = el("div", { class: "table-card" });
    const head = el("div", { class: "table-card-head" });
    head.append(
      el("h3", { text: table.name }),
      el("span", { class: "badge", text: table.format }),
      el("span", { class: "badge", text: `${table.columns.length} 列` }),
      el("span", { class: "badge", text: formatBytes(table.file.bytes) }),
      el("span", { class: "spacer" }),
    );
    const preview = el("button", { class: "link", text: "预览 50 行" });
    preview.addEventListener("click", () => {
      mustGet<HTMLTextAreaElement>("sql-query").value = `select * from ${quoteIdentifier(table.name)} limit 50`;
      showTab("sql");
      void runSql();
    });
    head.append(preview);

    const body = el("div", { class: "table-card-body" });
    const schema = el("table", { class: "schema" });
    const thead = el("thead");
    thead.append(rowOf(["列", "类型", "可空", "主键"].map(label => el("th", { text: label }))));
    const tbody = el("tbody");
    for (const column of table.columns) {
      tbody.append(rowOf([
        el("td", { text: column.name }),
        el("td", { text: column.type }),
        el("td", { text: column.nullable ? "是" : "否" }),
        el("td", { text: table.primaryKey.includes(column.name) ? "●" : "" }),
      ]));
    }
    schema.append(thead, tbody);
    body.append(schema);
    if (table.primaryKey.length > 0) body.append(el("p", { class: "hint", text: `主键：${table.primaryKey.join(", ")}` }));
    card.append(head, body);
    container.append(card);
  }
}

function renderVectorCollections(manifest: Readonly<WeiSQLManifest>): void {
  const container = mustGet("vectors");
  clear(container);
  if (manifest.vectorCollections.length === 0) {
    container.append(el("div", { class: "placeholder", text: "此数据包没有声明向量集合。" }));
    return;
  }
  for (const vector of manifest.vectorCollections) {
    const item = el("div", { class: "list-item" });
    item.append(
      el("div", { class: "title", text: vector.name }),
      el("div", { class: "meta", text: `${vector.count} 条 · 维度 ${vector.dimension} · ${vector.metric} · ${formatBytes(vector.data.bytes)}` }),
      el("div", { class: "meta", text: `表 ${vector.tableName} · ID 列 ${vector.idColumn}` }),
    );
    container.append(item);
  }
}

function renderTextIndexes(manifest: Readonly<WeiSQLManifest>): void {
  const container = mustGet("text-indexes");
  clear(container);
  const indexes = manifest.textIndexes ?? [];
  if (indexes.length === 0) {
    container.append(el("div", { class: "placeholder", text: "此数据包没有声明全文索引。" }));
    return;
  }
  for (const index of indexes) {
    const item = el("div", { class: "list-item" });
    item.append(
      el("div", { class: "title", text: index.name }),
      el("div", { class: "meta", text: `表 ${index.tableName} · 列 ${index.column} · ${index.documentCount} 文档 · ${index.termCount} terms` }),
      el("div", { class: "meta", text: `平均文档长度 ${index.averageDocumentLength.toFixed(2)}` }),
    );
    container.append(item);
  }
}

function populateSelects(manifest: Readonly<WeiSQLManifest>): void {
  const vectorSelect = mustGet<HTMLSelectElement>("vector-collection");
  clear(vectorSelect);
  for (const vector of manifest.vectorCollections) {
    vectorSelect.append(new Option(`${vector.name}（${vector.count}×${vector.dimension}）`, vector.name));
  }
  const hasVector = manifest.vectorCollections.length > 0;
  vectorSelect.disabled = !hasVector;
  mustGet<HTMLButtonElement>("vector-run").disabled = !hasVector;
  mustGet<HTMLButtonElement>("vector-load-presets").disabled = !hasVector;
  mustGet("vector-query").setAttribute("placeholder", hasVector ? "例如 0.12, -0.4, 0.88" : "此数据包没有向量集合");

  const textSelect = mustGet<HTMLSelectElement>("text-index");
  clear(textSelect);
  for (const index of manifest.textIndexes ?? []) {
    textSelect.append(new Option(`${index.name}（${index.documentCount} 文档）`, index.name));
  }
  const hasText = (manifest.textIndexes ?? []).length > 0;
  textSelect.disabled = !hasText;
  mustGet<HTMLButtonElement>("text-run").disabled = !hasText;
  mustGet("text-empty").hidden = hasText;
  mustGet("text-query").setAttribute("placeholder", hasText ? "输入查询词，例如 dna" : "此数据包未声明全文索引");

  updateFilterColumns();
  const firstTable = manifest.tables[0];
  if (firstTable !== undefined) {
    mustGet<HTMLTextAreaElement>("sql-query").value = `select * from ${quoteIdentifier(firstTable.name)} limit 50`;
  }
}

function updateFilterColumns(): void {
  const current = session;
  if (current === undefined) return;
  const name = mustGet<HTMLSelectElement>("vector-collection").value;
  const vector = current.manifest.vectorCollections.find(item => item.name === name);
  const table = vector === undefined ? undefined : current.manifest.tables.find(item => item.name === vector.tableName);
  const list = mustGet<HTMLDataListElement>("vector-columns");
  clear(list);
  for (const column of table?.columns ?? []) {
    const option = document.createElement("option");
    option.value = column.name;
    list.append(option);
  }
  if (table !== undefined) {
    const column = table.columns[0];
    if (column !== undefined && mustGet<HTMLInputElement>("vector-filter-column").value === "") {
      mustGet<HTMLInputElement>("vector-filter-column").value = column.name;
    }
  }
}

function renderDiagnostics(): void {
  const current = session;
  const pairs: [string, string][] = [];
  if (current !== undefined) {
    pairs.push(
      ["读取调用", String(current.reader.stats.calls)],
      ["读取字节", formatBytes(current.reader.stats.bytes)],
      ["SQL 运行时", current.sql === undefined ? "未加载" : "DuckDB-Wasm 已加载"],
      ["来源", current.mode],
    );
  } else {
    pairs.push(["读取调用", "0"], ["读取字节", "0 B"], ["SQL 运行时", "未加载"]);
  }
  pairs.push(["后端", backend === undefined ? "浏览器（示例）" : "Tauri IPC"]);
  renderPairs(mustGet("diagnostics"), pairs);
}

async function ensureSql(): Promise<WeiSQLDatabase> {
  const current = session;
  if (current === undefined) throw new Error("尚未打开数据包");
  if (current.sql !== undefined) return current.sql.db;

  setStatus("加载 DuckDB-Wasm（首次约 34 MB）…");
  mustGet("sql-status").textContent = "加载运行时…";
  const reader = await createReaderFor(current);
  const adapter: SqlAdapter = await createSqlAdapter();
  const db = await open({
    manifest: current.manifest as WeiSQLManifest,
    resourceReader: reader,
    sqlAdapter: adapter,
  });
  if (session !== current) {
    await db.close();
    throw new Error("数据包已切换");
  }
  current.sql = { db, reader };
  renderDiagnostics();
  return db;
}

async function runSql(): Promise<void> {
  const current = session;
  if (current === undefined) return;
  const query = mustGet<HTMLTextAreaElement>("sql-query").value.trim();
  if (query === "") return;
  hideError("sql-error");
  mustGet("sql-status").textContent = "运行中…";
  const started = performance.now();
  try {
    const db = await ensureSql();
    const limit = clamp(Number(mustGet<HTMLInputElement>("sql-limit").value), 1, 10_000, 200);
    const rows = await db.sql(query, [], { maxRows: limit });
    const elapsed = Math.round(performance.now() - started);
    renderRows(mustGet<HTMLTableElement>("sql-table"), rows);
    mustGet("sql-result-wrap").hidden = false;
    mustGet("sql-status").textContent = `${rows.length} 行 · ${elapsed} ms`;
    setStatus(`SQL 完成：${rows.length} 行 · ${elapsed} ms`);
    publish({ ok: true, sqlRows: rows.length, sqlMs: elapsed });
    renderDiagnostics();
  } catch (error) {
    mustGet("sql-status").textContent = "失败";
    mustGet("sql-result-wrap").hidden = true;
    showError("sql-error", errorText(error));
    setStatus(`SQL 失败：${errorText(error)}`);
    publish({ ok: false, error: errorText(error) });
  }
}

async function runVectorSearch(): Promise<void> {
  const current = session;
  if (current === undefined) return;
  hideError("vector-error");
  const name = mustGet<HTMLSelectElement>("vector-collection").value;
  const collection = current.manifest.vectorCollections.find(item => item.name === name);
  if (collection === undefined) {
    showError("vector-error", "没有可用的向量集合");
    return;
  }
  mustGet("vector-status").textContent = "检索中…";
  const started = performance.now();
  try {
    const values = parseVector(mustGet<HTMLInputElement>("vector-query").value, collection.dimension);
    const topK = clamp(Number(mustGet<HTMLInputElement>("vector-topk").value), 1, 100, 5);
    const filtered = mustGet<HTMLInputElement>("vector-filter-enabled").checked;
    const filter = filtered ? buildFilter(current, collection.tableName, collection.name) : undefined;
    const db = filter === undefined ? current.db : await ensureSql();
    const hits: readonly VectorHit[] = await db.vector.search(collection.name, values, {
      topK,
      ...(filter === undefined ? {} : { filter }),
    });
    const elapsed = Math.round(performance.now() - started);
    renderVectorHits(hits);
    mustGet("vector-result-wrap").hidden = false;
    mustGet("vector-status").textContent = `${hits.length} 条 · ${elapsed} ms${filter === undefined ? "" : " · 已过滤"}`;
    setStatus(`向量检索：${hits.length} 条 · ${elapsed} ms`);
    publish({
      ok: true,
      vectorIds: hits.map(hit => hit.id),
      vectorDistances: hits.map(hit => Number(hit.distance.toFixed(6))),
    });
    renderDiagnostics();
  } catch (error) {
    mustGet("vector-status").textContent = "失败";
    mustGet("vector-result-wrap").hidden = true;
    showError("vector-error", errorText(error));
    setStatus(`向量检索失败：${errorText(error)}`);
    publish({ ok: false, error: errorText(error) });
  }
}

function buildFilter(
  current: Session,
  tableName: string,
  vectorName: string,
): Readonly<Record<string, string | number | boolean>> {
  const columnName = mustGet<HTMLInputElement>("vector-filter-column").value.trim();
  const raw = mustGet<HTMLInputElement>("vector-filter-value").value;
  if (columnName === "") throw new Error("过滤需要列名");
  const table = current.manifest.tables.find(item => item.name === tableName);
  const column = table?.columns.find(item => item.name === columnName);
  if (column === undefined) throw new Error(`表 ${tableName} 没有列 ${columnName}`);
  if (column.type === "int32" || column.type === "int64" || column.type === "float32" || column.type === "float64") {
    const value = Number(raw);
    if (!Number.isFinite(value)) throw new Error(`列 ${columnName} 需要数字`);
    return { [columnName]: value };
  }
  if (column.type === "boolean") {
    if (raw !== "true" && raw !== "false") throw new Error(`列 ${columnName} 需要 true 或 false`);
    return { [columnName]: raw === "true" };
  }
  void vectorName;
  return { [columnName]: raw };
}

async function loadPresets(): Promise<void> {
  const current = session;
  if (current === undefined) return;
  const name = mustGet<HTMLSelectElement>("vector-collection").value;
  const collection = current.manifest.vectorCollections.find(item => item.name === name);
  if (collection === undefined) return;
  const count = Math.min(3, collection.count);
  if (count === 0) return;
  const bytes = await current.reader.readRange(collection.data.path, {
    start: 0,
    end: count * collection.dimension * 4,
  });
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  presets = Array.from({ length: count }, (_, row) => ({
    row,
    values: Array.from({ length: collection.dimension }, (_, index) => view.getFloat32((row * collection.dimension + index) * 4, true)),
  }));
  renderPresets();
  if (mustGet<HTMLInputElement>("vector-query").value === "" && presets[0] !== undefined) {
    mustGet<HTMLInputElement>("vector-query").value = presets[0].values.map(value => Number(value.toFixed(4))).join(", ");
  }
  renderDiagnostics();
}

function renderPresets(): void {
  const container = mustGet("vector-presets");
  clear(container);
  for (const preset of presets) {
    const button = el("button", { class: "chip", text: `row ${preset.row}` });
    button.type = "button";
    button.title = preset.values.join(", ");
    button.addEventListener("click", () => {
      mustGet<HTMLInputElement>("vector-query").value = preset.values.map(value => Number(value.toFixed(4))).join(", ");
      for (const sibling of container.querySelectorAll(".chip")) sibling.setAttribute("aria-pressed", "false");
      button.setAttribute("aria-pressed", "true");
    });
    container.append(button);
  }
}

async function runTextSearch(): Promise<void> {
  const current = session;
  if (current === undefined) return;
  hideError("text-error");
  const name = mustGet<HTMLSelectElement>("text-index").value;
  const query = mustGet<HTMLInputElement>("text-query").value.trim();
  if (query === "") {
    showError("text-error", "请输入查询词");
    return;
  }
  mustGet("text-status").textContent = "检索中…";
  const started = performance.now();
  try {
    const topK = clamp(Number(mustGet<HTMLInputElement>("text-topk").value), 1, 100, 10);
    const hits: readonly TextHit[] = await current.db.text.search(name, query, { topK });
    const elapsed = Math.round(performance.now() - started);
    renderTextHits(hits);
    mustGet("text-result-wrap").hidden = false;
    mustGet("text-status").textContent = `${hits.length} 条 · ${elapsed} ms`;
    setStatus(`全文检索：${hits.length} 条 · ${elapsed} ms`);
    publish({ ok: true, textIds: hits.map(hit => hit.id) });
    renderDiagnostics();
  } catch (error) {
    mustGet("text-status").textContent = "失败";
    mustGet("text-result-wrap").hidden = true;
    showError("text-error", errorText(error));
    setStatus(`全文检索失败：${errorText(error)}`);
    publish({ ok: false, error: errorText(error) });
  }
}

function parseVector(text: string, dimension: number): number[] {
  const parts = text.split(/[\s,，;]+/).filter(part => part.length > 0);
  if (parts.length === 0) throw new Error("请输入查询向量");
  const values = parts.map(part => Number(part));
  values.forEach((value, index) => {
    if (!Number.isFinite(value)) throw new Error(`第 ${index + 1} 个分量不是数字`);
  });
  if (values.length !== dimension) throw new Error(`向量维度为 ${dimension}，当前输入了 ${values.length} 个分量`);
  return values;
}

function renderRows(table: HTMLTableElement, rows: readonly Record<string, unknown>[]): void {
  const head = table.tHead ?? table.createTHead();
  const body = table.tBodies[0] ?? table.createTBody();
  clear(head);
  clear(body);
  if (rows.length === 0) {
    const row = el("tr");
    const cell = el("td", { class: "muted", text: "查询成功，没有返回行" });
    cell.colSpan = 1;
    row.append(cell);
    body.append(row);
    return;
  }
  const columns = Object.keys(rows[0] ?? {});
  head.append(rowOf(columns.map(column => el("th", { text: column }))));
  for (const record of rows) {
    body.append(rowOf(columns.map(column => {
      const value = record[column];
      const cell = el("td", { text: formatValue(value) });
      if (value === null) cell.classList.add("muted");
      if (typeof value === "number" || typeof value === "bigint") cell.classList.add("num");
      return cell;
    })));
  }
}

function renderVectorHits(hits: readonly VectorHit[]): void {
  const table = mustGet<HTMLTableElement>("vector-table");
  const body = table.tBodies[0] ?? table.createTBody();
  clear(body);
  if (hits.length === 0) {
    body.append(rowOf([el("td", { class: "muted", text: "没有命中" })]));
    return;
  }
  for (const hit of hits) {
    body.append(rowOf([
      el("td", { class: "num", text: String(hit.row) }),
      el("td", { text: String(hit.id) }),
      el("td", { class: "num", text: hit.distance.toFixed(6) }),
      el("td", { class: "muted", text: `${hit.diagnostics?.backend ?? "-"}${hit.diagnostics?.exact === false ? " · 近似" : ""}` }),
    ]));
  }
}

function renderTextHits(hits: readonly TextHit[]): void {
  const table = mustGet<HTMLTableElement>("text-table");
  const body = table.tBodies[0] ?? table.createTBody();
  clear(body);
  if (hits.length === 0) {
    body.append(rowOf([el("td", { class: "muted", text: "没有命中" })]));
    return;
  }
  for (const hit of hits) {
    body.append(rowOf([
      el("td", { class: "num", text: String(hit.row) }),
      el("td", { text: String(hit.id) }),
      el("td", { class: "num", text: hit.score.toFixed(4) }),
    ]));
  }
}

function rowOf(cells: readonly HTMLElement[]): HTMLTableRowElement {
  const row = el("tr");
  for (const cell of cells) row.append(cell);
  return row;
}

function quoteIdentifier(name: string): string {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ? name : `"${name.replace(/"/g, '""')}"`;
}

function clamp(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

function showError(id: string, message: string): void {
  const element = mustGet(id);
  element.hidden = false;
  element.textContent = message;
}

function hideError(id: string): void {
  mustGet(id).hidden = true;
}

function showOpenError(message: string): void {
  showError("open-error", message);
}

function hideOpenError(): void {
  hideError("open-error");
}

function publish(update: Record<string, unknown>): void {
  window.__DESKTOP_STATE = { ...(window.__DESKTOP_STATE ?? {}), ...update };
}

function wireTabs(): void {
  for (const tab of document.querySelectorAll<HTMLButtonElement>(".tab")) {
    tab.addEventListener("click", () => showTab(tab.dataset.tab ?? "overview"));
  }
}

function showTab(name: string): void {
  for (const tab of document.querySelectorAll<HTMLButtonElement>(".tab")) {
    tab.setAttribute("aria-selected", String(tab.dataset.tab === name));
  }
  for (const panel of document.querySelectorAll<HTMLElement>(".panel")) {
    panel.hidden = panel.dataset.panel !== name;
  }
}

function wireOpenButtons(): void {
  const bind = (id: string, action: () => Promise<void>) => {
    const button = document.getElementById(id);
    button?.addEventListener("click", () => void action());
  };
  bind("open-directory", chooseDirectory);
  bind("empty-open-directory", chooseDirectory);
  bind("open-container", chooseContainer);
  bind("empty-open-container", chooseContainer);
  bind("open-sample", openSample);
  bind("empty-open-sample", openSample);
}

function wireSql(): void {
  mustGet("sql-run").addEventListener("click", () => void runSql());
  mustGet<HTMLTextAreaElement>("sql-query").addEventListener("keydown", event => {
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      void runSql();
    }
  });
}

function wireVector(): void {
  mustGet("vector-run").addEventListener("click", () => void runVectorSearch());
  mustGet("vector-load-presets").addEventListener("click", () => {
    void loadPresets().catch(error => showError("vector-error", errorText(error)));
  });
  mustGet("vector-collection").addEventListener("change", () => updateFilterColumns());
}

function wireText(): void {
  mustGet("text-run").addEventListener("click", () => void runTextSearch());
  mustGet<HTMLInputElement>("text-query").addEventListener("keydown", event => {
    if (event.key === "Enter") {
      event.preventDefault();
      void runTextSearch();
    }
  });
}
