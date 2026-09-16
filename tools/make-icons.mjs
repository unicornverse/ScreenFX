/* ============================================================================
 * ScreenFX icon generator
 * ----------------------------------------------------------------------------
 * Draws the toolbar mark — an accent-blue tile with a white fracture bolt —
 * and writes 16/48/128px PNGs with a hand-rolled encoder (zlib is the only
 * dependency, so the repo stays asset-free).
 *
 *   node tools/make-icons.mjs
 * ========================================================================== */
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'icons');

const TILE  = [0x0A, 0x7C, 0xFF];   /* the product accent */
const GLYPH = [0xFF, 0xFF, 0xFF];

/* the fracture bolt, in 0..1 tile space */
const BOLT = [
  [0.575, 0.055], [0.335, 0.505], [0.470, 0.505],
  [0.395, 0.955], [0.700, 0.455], [0.545, 0.455], [0.680, 0.055]
];
/* two hairline cracks splitting off the bolt */
const CRACKS = [
  [[0.445, 0.300], [0.215, 0.215]],
  [[0.560, 0.640], [0.790, 0.735]],
  [[0.505, 0.180], [0.300, 0.105]]
];
const CRACK_W = 0.026;

const inPoly = (x, y, poly) => {
  let hit = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) hit = !hit;
  }
  return hit;
};

const nearSeg = (x, y, [[ax, ay], [bx, by]], w) => {
  const dx = bx - ax, dy = by - ay;
  const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(x - (ax + t * dx), y - (ay + t * dy)) <= w;
};

const inTile = (x, y, r) => {
  if (x < 0 || x > 1 || y < 0 || y > 1) return false;
  const dx = Math.max(r - x, x - (1 - r), 0);
  const dy = Math.max(r - y, y - (1 - r), 0);
  return dx * dx + dy * dy <= r * r;
};

function render(size) {
  const SS = 4;                          // supersample factor for clean edges
  const radius = size <= 20 ? 0.16 : 0.21;
  const px = Buffer.alloc(size * size * 4);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let tile = 0, glyph = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const u = (x + (sx + 0.5) / SS) / size;
          const v = (y + (sy + 0.5) / SS) / size;
          if (!inTile(u, v, radius)) continue;
          tile++;
          if (inPoly(u, v, BOLT) || CRACKS.some((s) => nearSeg(u, v, s, CRACK_W))) glyph++;
        }
      }
      const n = SS * SS;
      const a = tile / n;                              // tile coverage -> alpha
      const g = tile ? glyph / tile : 0;               // glyph share of the tile
      const i = (y * size + x) * 4;
      for (let c = 0; c < 3; c++) px[i + c] = Math.round(TILE[c] * (1 - g) + GLYPH[c] * g);
      px[i + 3] = Math.round(a * 255);
    }
  }
  return px;
}

/* ---------- minimal PNG encoder ------------------------------------------ */

const CRC = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (const b of buf) c = CRC[(c ^ b) & 0xFF] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function png(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;    // bit depth
  ihdr[9] = 6;    // truecolour with alpha
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;   // filter: none
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

mkdirSync(OUT, { recursive: true });
for (const size of [16, 32, 48, 128]) {
  const file = join(OUT, `icon${size}.png`);
  writeFileSync(file, png(size, render(size)));
  console.log('wrote', file);
}
