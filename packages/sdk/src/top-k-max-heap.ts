import { WeiSQLError } from "./errors.js";

export interface RankedCandidate { row: number; id: string | number; distance: number }

/** Negative means a is better; positive means a is worse. */
export function compareCandidate(a: RankedCandidate, b: RankedCandidate): number {
  if (a.distance < b.distance) return -1;
  if (a.distance > b.distance) return 1;
  return a.row - b.row;
}

/** Fixed-capacity max heap whose root is the worst retained candidate. */
export class TopKMaxHeap<T extends RankedCandidate = RankedCandidate> {
  private readonly heap: T[] = [];
  constructor(readonly capacity: number) {
    if (!Number.isSafeInteger(capacity) || capacity <= 0) throw new WeiSQLError("INVALID_ARGUMENT", "topK must be a positive safe integer", { topK: capacity });
  }
  get size(): number { return this.heap.length; }
  offer(candidate: T): void {
    if (!Number.isSafeInteger(candidate.row) || candidate.row < 0 || !Number.isFinite(candidate.distance) || (typeof candidate.id !== "string" && (typeof candidate.id !== "number" || !Number.isSafeInteger(candidate.id))) || candidate.id === "") {
      throw new WeiSQLError("INVALID_ARGUMENT", "Invalid ranked candidate", { candidate });
    }
    if (this.heap.length < this.capacity) { this.heap.push(candidate); this.siftUp(this.heap.length - 1); return; }
    if (compareCandidate(candidate, this.heap[0]!) < 0) { this.heap[0] = candidate; this.siftDown(0); }
  }
  toSortedArray(): T[] { return [...this.heap].sort(compareCandidate); }
  private siftUp(index: number): void {
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      if (compareCandidate(this.heap[parent]!, this.heap[index]!) >= 0) break;
      this.swap(parent, index); index = parent;
    }
  }
  private siftDown(index: number): void {
    while (true) {
      const left = index * 2 + 1; const right = left + 1; let worst = index;
      if (left < this.heap.length && compareCandidate(this.heap[left]!, this.heap[worst]!) > 0) worst = left;
      if (right < this.heap.length && compareCandidate(this.heap[right]!, this.heap[worst]!) > 0) worst = right;
      if (worst === index) return;
      this.swap(index, worst); index = worst;
    }
  }
  private swap(a: number, b: number): void { const value = this.heap[a]!; this.heap[a] = this.heap[b]!; this.heap[b] = value; }
}
