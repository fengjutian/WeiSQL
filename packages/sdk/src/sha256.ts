/**
 * Minimal incremental SHA-256 (FIPS 180-4) with no runtime dependencies.
 *
 * Runtime and Builder hash untrusted resources that may be far larger than the
 * available memory budget, so the digest must be streamable and must behave
 * identically in browsers and Node.js. Catching accidental corruption is the
 * only goal: this proves content matches the Manifest, not publisher identity.
 */

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const BLOCK_BYTES = 64;

export class Sha256 {
  private readonly state = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  private readonly schedule = new Uint32Array(64);
  private readonly pending = new Uint8Array(BLOCK_BYTES);
  private pendingBytes = 0;
  private hashedBytes = 0;
  private finalized = false;

  update(input: Uint8Array): this {
    assertNotFinalized(this.finalized);
    let offset = 0;
    this.hashedBytes += input.byteLength;
    if (this.pendingBytes > 0) {
      const fill = Math.min(BLOCK_BYTES - this.pendingBytes, input.byteLength);
      this.pending.set(input.subarray(0, fill), this.pendingBytes);
      this.pendingBytes += fill;
      offset = fill;
      if (this.pendingBytes === BLOCK_BYTES) {
        this.compress(this.pending, 0);
        this.pendingBytes = 0;
      }
    }
    const complete = input.byteLength - (BLOCK_BYTES - 1);
    while (offset < complete) {
      this.compress(input, offset);
      offset += BLOCK_BYTES;
    }
    while (offset < input.byteLength) this.pending[this.pendingBytes++] = input[offset++]!;
    return this;
  }

  /** Finalize and return the 32-byte digest. The instance cannot be reused. */
  digest(): Uint8Array {
    assertNotFinalized(this.finalized);
    this.finalized = true;
    const bitLength = BigInt(this.hashedBytes) * 8n;
    const padding = new Uint8Array(this.pendingBytes < 56 ? BLOCK_BYTES : BLOCK_BYTES * 2);
    padding.set(this.pending.subarray(0, this.pendingBytes));
    padding[this.pendingBytes] = 0x80;
    new DataView(padding.buffer, padding.byteOffset, padding.byteLength).setBigUint64(padding.byteLength - 8, bitLength);
    for (let offset = 0; offset < padding.byteLength; offset += BLOCK_BYTES) this.compress(padding, offset);
    const digest = new Uint8Array(32);
    const view = new DataView(digest.buffer);
    for (let i = 0; i < 8; i++) view.setUint32(i * 4, this.state[i]!);
    return digest;
  }

  private compress(input: Uint8Array, offset: number): void {
    const w = this.schedule;
    for (let i = 0; i < 16; i++) {
      const base = offset + i * 4;
      w[i] = ((input[base]! << 24) | (input[base + 1]! << 16) | (input[base + 2]! << 8) | input[base + 3]!) >>> 0;
    }
    for (let i = 16; i < 64; i++) {
      const first = w[i - 15]!;
      const second = w[i - 2]!;
      const s0 = ((first >>> 7) | (first << 25)) ^ ((first >>> 18) | (first << 14)) ^ (first >>> 3);
      const s1 = ((second >>> 17) | (second << 15)) ^ ((second >>> 19) | (second << 13)) ^ (second >>> 10);
      w[i] = (w[i - 16]! + s0 + w[i - 7]! + s1) >>> 0;
    }
    let a = this.state[0]!;
    let b = this.state[1]!;
    let c = this.state[2]!;
    let d = this.state[3]!;
    let e = this.state[4]!;
    let f = this.state[5]!;
    let g = this.state[6]!;
    let h = this.state[7]!;
    for (let i = 0; i < 64; i++) {
      const s1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const choose = (e & f) ^ (~e & g);
      const t1 = (h + s1 + choose + K[i]! + w[i]!) >>> 0;
      const s0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (s0 + majority) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }
    this.state[0] = (this.state[0]! + a) >>> 0;
    this.state[1] = (this.state[1]! + b) >>> 0;
    this.state[2] = (this.state[2]! + c) >>> 0;
    this.state[3] = (this.state[3]! + d) >>> 0;
    this.state[4] = (this.state[4]! + e) >>> 0;
    this.state[5] = (this.state[5]! + f) >>> 0;
    this.state[6] = (this.state[6]! + g) >>> 0;
    this.state[7] = (this.state[7]! + h) >>> 0;
  }
}

/** Lowercase hexadecimal SHA-256 of a complete byte sequence. */
export function sha256Hex(bytes: Uint8Array): string {
  return toHex(new Sha256().update(bytes).digest());
}

export function toHex(bytes: Uint8Array): string {
  let hex = "";
  for (let i = 0; i < bytes.length; i++) hex += bytes[i]!.toString(16).padStart(2, "0");
  return hex;
}

function assertNotFinalized(finalized: boolean): void {
  if (finalized) throw new Error("SHA-256 digest has already been finalized");
}
