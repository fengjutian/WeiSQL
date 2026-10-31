/**
 * Draws the app icon (no native image dependency) and writes a 1024×1024 PNG.
 * `cargo tauri icon app-icon.png` turns it into the platform icon set.
 *
 *   node scripts/make-icon.mjs
 */
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SIZE = 1024;
const RADIUS = 210;
const STROKE = 78;
const POINTS = [
  [250, 340],
  [430, 700],
  [512, 470],
  [594, 700],
  [774, 340],
];

const pixels = Buffer.alloc(SIZE * SIZE * 4);

function smoothstep(edge0, edge1, value) {
  const t = Math.min(1, Math.max(0, (value - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

function distanceToSegment(px, py, [ax, ay], [bx, by]) {
  const dx = bx - ax;
  const dy = by - ay;
  const lengthSquared = dx * dx + dy * dy;
  const t = lengthSquared === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lengthSquared));
  const x = ax + t * dx;
  const y = ay + t * dy;
  return Math.hypot(px - x, py - y);
}

for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    // Rounded-square mask with a one-pixel antialiased edge.
    const innerX = Math.abs(x + 0.5 - SIZE / 2) - (SIZE / 2 - RADIUS);
    const innerY = Math.abs(y + 0.5 - SIZE / 2) - (SIZE / 2 - RADIUS);
    const outside = Math.hypot(Math.max(innerX, 0), Math.max(innerY, 0));
    const cornerDistance = Math.max(0, outside - RADIUS);
    const coverage = 1 - smoothstep(0, 1.5, cornerDistance);

    const t = (x + y) / (2 * SIZE);
    let r = 91 + (43 - 91) * t;
    let g = 140 + (212 - 140) * t;
    let b = 255 + (167 - 255) * t;

    let strokeDistance = Infinity;
    for (let index = 0; index < POINTS.length - 1; index++) {
      strokeDistance = Math.min(strokeDistance, distanceToSegment(x + 0.5, y + 0.5, POINTS[index], POINTS[index + 1]));
    }
    const mark = 1 - smoothstep(STROKE / 2 - 1, STROKE / 2 + 1, strokeDistance);
    r = r + (255 - r) * mark;
    g = g + (255 - g) * mark;
    b = b + (255 - b) * mark;

    const offset = (y * SIZE + x) * 4;
    pixels[offset] = Math.round(r);
    pixels[offset + 1] = Math.round(g);
    pixels[offset + 2] = Math.round(b);
    pixels[offset + 3] = Math.round(255 * coverage);
  }
}

function chunk(type, payload) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(payload.length, 0);
  const body = Buffer.concat([Buffer.from(type, "ascii"), payload]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body) >>> 0, 0);
  return Buffer.concat([length, body, crc]);
}

const CRC_TABLE = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  CRC_TABLE[n] = c >>> 0;
}
function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return crc ^ 0xffffffff;
}

const header = Buffer.alloc(13);
header.writeUInt32BE(SIZE, 0);
header.writeUInt32BE(SIZE, 4);
header[8] = 8; // bit depth
header[9] = 6; // RGBA
// Each scanline needs a filter byte; filter 0 (None) keeps the encoder trivial.
const raw = Buffer.alloc((SIZE * 4 + 1) * SIZE);
for (let y = 0; y < SIZE; y++) {
  raw[y * (SIZE * 4 + 1)] = 0;
  pixels.copy(raw, y * (SIZE * 4 + 1) + 1, y * SIZE * 4, (y + 1) * SIZE * 4);
}

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk("IHDR", header),
  chunk("IDAT", deflateSync(raw, { level: 9 })),
  chunk("IEND", Buffer.alloc(0)),
]);

const target = path.join(HERE, "..", "app-icon.png");
writeFileSync(target, png);
console.log(`wrote ${path.relative(process.cwd(), target)} (${png.byteLength} bytes)`);
