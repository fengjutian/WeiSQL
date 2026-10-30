import { WeiSQLError } from "./errors.js";

export interface RowGroup {
  startRow: number;
  count: number;
  outputIndexes: number[];
}

/** Sort unique rows and merge adjacent rows while retaining caller positions. */
export function groupRows(rows: readonly number[]): RowGroup[] {
  const seen = new Set<number>();
  const sorted = rows.map((row, outputIndex) => {
    if (!Number.isSafeInteger(row) || row < 0) throw new WeiSQLError("INVALID_ARGUMENT", "ID row must be a non-negative safe integer", { row });
    if (seen.has(row)) throw new WeiSQLError("INVALID_ARGUMENT", "Duplicate ID row request", { row });
    seen.add(row);
    return { row, outputIndex };
  }).sort((a, b) => a.row - b.row);
  const groups: RowGroup[] = [];
  for (const item of sorted) {
    const last = groups[groups.length - 1];
    if (last && item.row === last.startRow + last.count) {
      last.count++;
      last.outputIndexes.push(item.outputIndex);
    } else groups.push({ startRow: item.row, count: 1, outputIndexes: [item.outputIndex] });
  }
  return groups;
}
