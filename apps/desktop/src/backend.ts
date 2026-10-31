import { invoke } from "@tauri-apps/api/core";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";

export interface FileStat {
  size: number;
  isDirectory: boolean;
  lastModified?: number;
}

export interface FileEntry {
  path: string;
  size: number;
}

/** True when the page runs inside the Tauri webview rather than a plain browser. */
export function isTauriRuntime(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/**
 * Native file access. Every read goes through an IPC command; the webview never
 * receives a path handle, so the smaller the requested range the cheaper the call.
 */
export class TauriBackend {
  readonly kind = "tauri" as const;

  async pickDirectory(): Promise<string | undefined> {
    const selected = await openFileDialog({
      directory: true,
      multiple: false,
      title: "选择 WeiSQL 数据包目录",
    });
    return typeof selected === "string" ? selected : undefined;
  }

  async pickContainer(): Promise<string | undefined> {
    const selected = await openFileDialog({
      directory: false,
      multiple: false,
      title: "选择 .wsql 数据包",
      filters: [{ name: "WeiSQL 数据包", extensions: ["wsql"] }],
    });
    return typeof selected === "string" ? selected : undefined;
  }

  async stat(path: string): Promise<FileStat> {
    return invoke<FileStat>("stat_file", { path });
  }

  async readFile(path: string): Promise<Uint8Array> {
    return toBytes(await invoke<ArrayBuffer | number[]>("read_file", { path }));
  }

  async readRange(path: string, start: number, end: number): Promise<Uint8Array> {
    return toBytes(await invoke<ArrayBuffer | number[]>("read_range", { path, start, end }));
  }

  async listFiles(path: string): Promise<FileEntry[]> {
    return invoke<FileEntry[]>("list_files", { path });
  }
}

function toBytes(value: ArrayBuffer | Uint8Array | number[]): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  return Uint8Array.from(value);
}
