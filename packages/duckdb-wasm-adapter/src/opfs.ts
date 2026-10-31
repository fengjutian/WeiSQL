/**
 * OPFS helpers for the DuckDB-Wasm adapter.
 *
 * DuckDB-Wasm can keep a real database file in the browser's Origin Private File
 * System, but the file is only valid after `flushFiles()`; without it the OPFS
 * entry is an empty shell and reopening reports "not a valid DuckDB database
 * file". Those details live in ADR-070.
 */
import type { WeiSQLManifest } from "@weisql/sdk";

export const OPFS_DATABASE_PREFIX = "weisql-";
const DATABASE_FILE = /^(weisql-[0-9a-f]{32}\.db)/;

interface OpfsDirectoryLike {
  getFileHandle(name: string): Promise<unknown>;
  entries?(): AsyncIterableIterator<[string, { getFile(): Promise<{ lastModified: number }> }]>;
  removeEntry?(name: string): Promise<void>;
}

interface OpfsStorageLike {
  getDirectory(): Promise<OpfsDirectoryLike>;
}

/**
 * Deterministic cache key: a change to any table's declared size or SHA-256
 * produces a different file, so a stale materialized table can never be reused
 * for different bytes. Only table descriptors matter; vector collections are
 * serviced by other adapters.
 */
export async function opfsDatabaseFileName(manifest: Readonly<WeiSQLManifest>): Promise<string> {
  const tables = [...manifest.tables]
    .sort((left, right) => left.name.localeCompare(right.name))
    .map(table => [table.name, table.file.bytes, table.file.sha256]);
  const canonical = JSON.stringify({ formatVersion: manifest.formatVersion, tables });
  const digest = await sha256Hex(new TextEncoder().encode(canonical));
  return `${OPFS_DATABASE_PREFIX}${digest.slice(0, 32)}.db`;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const subtle = (globalThis as { crypto?: { subtle?: SubtleCryptoLike } }).crypto?.subtle;
  if (subtle === undefined) throw new Error("WebCrypto is unavailable");
  const digest = await subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

interface SubtleCryptoLike {
  digest(algorithm: string, data: Uint8Array): Promise<ArrayBuffer>;
}

/** True when OPFS contains `name`; throws when OPFS itself is unavailable. */
export async function opfsFileExists(name: string): Promise<boolean> {
  const storage = (globalThis as { navigator?: { storage?: OpfsStorageLike } }).navigator?.storage;
  if (storage?.getDirectory === undefined) throw new Error("OPFS is unavailable");
  const directory = await storage.getDirectory();
  try {
    await directory.getFileHandle(name);
    return true;
  } catch {
    return false;
  }
}

/**
 * Chooses which OPFS database files to delete. `keepName` is the database this
 * instance just opened; the other `maxDatabases - 1` newest entries survive, so
 * one app using a handful of packages keeps its hot caches without unbounded
 * growth. WAL companions share the base name and are evicted together.
 */
export function selectOpfsEvictions(
  entries: readonly { name: string; lastModified: number }[],
  keepName: string,
  maxDatabases = 4,
): string[] {
  const baseTimes = new Map<string, number>();
  for (const entry of entries) {
    const match = DATABASE_FILE.exec(entry.name);
    if (match === null) continue;
    const base = match[1]!;
    baseTimes.set(base, Math.max(baseTimes.get(base) ?? 0, entry.lastModified));
  }
  const survivors = new Set([keepName]);
  for (const [base] of [...baseTimes.entries()]
    .filter(([base]) => base !== keepName)
    .sort((left, right) => right[1] - left[1])
    .slice(0, Math.max(0, maxDatabases - 1))) {
    survivors.add(base);
  }
  return entries
    .filter(entry => {
      const match = DATABASE_FILE.exec(entry.name);
      return match === null || !survivors.has(match[1]!);
    })
    .map(entry => entry.name);
}

/** Best-effort eviction; returns the number of removed entries. */
export async function pruneOpfsDatabases(keepName: string, maxDatabases = 4): Promise<number> {
  const storage = (globalThis as { navigator?: { storage?: OpfsStorageLike } }).navigator?.storage;
  const directory = await storage?.getDirectory?.();
  const listEntries = directory?.entries?.bind(directory);
  const removeEntry = directory?.removeEntry?.bind(directory);
  if (listEntries === undefined || removeEntry === undefined) return 0;
  const entries: { name: string; lastModified: number }[] = [];
  for await (const [name, handle] of listEntries()) {
    try {
      entries.push({ name, lastModified: (await handle.getFile()).lastModified });
    } catch {
      // A file may disappear between listing and stat; it is already gone.
    }
  }
  const evictions = selectOpfsEvictions(entries, keepName, maxDatabases);
  for (const name of evictions) {
    await removeEntry(name).catch(() => undefined);
  }
  return evictions.length;
}
