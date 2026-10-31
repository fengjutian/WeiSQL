/** Small DOM helpers shared by the views. */

export function mustGet<T extends HTMLElement = HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (element === null) throw new Error(`missing element #${id}`);
  return element as T;
}

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  options: { class?: string; text?: string; title?: string } = {},
  ...children: (Node | string)[]
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  if (options.class !== undefined) element.className = options.class;
  if (options.text !== undefined) element.textContent = options.text;
  if (options.title !== undefined) element.title = options.title;
  for (const child of children) {
    element.append(typeof child === "string" ? document.createTextNode(child) : child);
  }
  return element;
}

export function clear(element: Element): void {
  element.replaceChildren();
}

export function formatBytes(bytes: number | undefined): string {
  if (bytes === undefined || !Number.isFinite(bytes)) return "—";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unit]}`;
}

/** Renders a definition list body from label/value pairs. */
export function renderPairs(list: HTMLElement, pairs: readonly (readonly [string, string])[]): void {
  clear(list);
  if (pairs.length === 0) {
    list.append(el("div", { class: "placeholder", text: "—" }));
    return;
  }
  for (const [label, value] of pairs) {
    const group = el("div", { class: "pair" });
    group.append(el("dt", { text: label }), el("dd", { text: value }));
    list.append(group);
  }
}

/** Formats a SQL/Arrow value without pretending it is a plain string. */
export function formatValue(value: unknown): string {
  if (value === null) return "NULL";
  if (value === undefined) return "";
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Uint8Array) return `0x${Array.from(value.slice(0, 16), byte => byte.toString(16).padStart(2, "0")).join("")}${value.byteLength > 16 ? "…" : ""}`;
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "object") {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

export function errorText(error: unknown): string {
  if (typeof error === "object" && error !== null) {
    const record = error as { code?: unknown; message?: unknown; details?: unknown };
    const code = typeof record.code === "string" ? `${record.code}: ` : "";
    const message = typeof record.message === "string" ? record.message : String(error);
    const details = record.details === undefined ? "" : ` ${JSON.stringify(record.details)}`;
    return `${code}${message}${details}`;
  }
  return String(error);
}

export function setStatus(text: string): void {
  const status = document.getElementById("status");
  if (status !== null) status.textContent = text;
}
