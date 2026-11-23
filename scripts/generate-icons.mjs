/**
 * Generates the launcher icon set (PNG + ICO) without external dependencies.
 * Draws the OctoClient octopus mark on a dark rounded tile and writes:
 *   src-tauri/icons/{16,32,48,64,128,256,512}.png
 *   src-tauri/icons/32x32.png, 128x128.png, 128x128@2x.png
 *   src-tauri/icons/icon.ico, icon.png
 * Re-run with: npm run icons
 */
import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = resolve(root, "src-tauri/icons");
mkdirSync(outDir, { recursive: true });

const SS = 4; // supersampling factor for anti-aliasing

const clamp01 = (v) => Math.min(1, Math.max(0, v));
const mix = (a, b, t) => a + (b - a) * t;

/** Distance from point p to segment a-b. */
function segmentDistance(px, py, ax, ay, bx, by) {
  const vx = bx - ax;
  const vy = by - ay;
  const wx = px - ax;
  const wy = py - ay;
  const len2 = vx * vx + vy * vy || 1;
  const t = clamp01((wx * vx + wy * vy) / len2);
  const dx = wx - vx * t;
  const dy = wy - vy * t;
  return Math.hypot(dx, dy);
}

/** Rounded-square signed distance (negative inside). */
function roundedBox(px, py, size, radius) {
  const half = size / 2;
  const dx = Math.abs(px - half) - (half - radius);
  const dy = Math.abs(py - half) - (half - radius);
  const outside = Math.hypot(Math.max(dx, 0), Math.max(dy, 0));
  return outside + Math.min(Math.max(dx, dy), 0) - radius;
}

/** OctoClient mark: dome head, two eyes and five curling tentacles. */
function octomark(px, py, size) {
  const cx = size * 0.5;
  const cy = size * 0.41;
  const headR = size * 0.215;
  const distHead = Math.hypot(px - cx, py - cy);
  // Flat-bottomed dome, so the tentacles read as a body and not a skull.
  const dome = 1 - clamp01((distHead - headR) / (size * 0.012));
  const cut = 1 - clamp01((py - (cy + headR * 0.5)) / (size * 0.01));
  const head = Math.min(dome, cut);

  const eyeR = size * 0.032;
  const eyeY = cy - size * 0.012;
  const eyeL =
    1 - clamp01((Math.hypot(px - (cx - size * 0.075), py - eyeY) - eyeR) / (size * 0.01));
  const eyeR2 =
    1 - clamp01((Math.hypot(px - (cx + size * 0.075), py - eyeY) - eyeR) / (size * 0.01));

  const thickness = Math.max(1, size * 0.024);
  const arms = [
    [-0.12, 0.13, -0.19, 0.26, -0.14, 0.39],
    [-0.06, 0.15, -0.09, 0.29, -0.05, 0.41],
    [0.0, 0.16, 0.0, 0.31, 0.01, 0.43],
    [0.06, 0.15, 0.09, 0.29, 0.05, 0.41],
    [0.12, 0.13, 0.19, 0.26, 0.14, 0.39],
  ];
  let tentacle = 0;
  for (const [x1, y1, x2, y2, x3, y3] of arms) {
    const ax = cx + x1 * size;
    const ay = cy + y1 * size;
    const bx = cx + x2 * size;
    const by = cy + y2 * size;
    const dx = cx + x3 * size;
    const dy = cy + y3 * size;
    const d = Math.min(
      segmentDistance(px, py, ax, ay, bx, by),
      segmentDistance(px, py, bx, by, dx, dy),
    );
    tentacle = Math.max(tentacle, 1 - clamp01((d - thickness) / (thickness * 0.9)));
  }

  const core = Math.max(head, tentacle);
  const glow = Math.max(1 - clamp01((distHead - headR) / (size * 0.34)), tentacle * 0.5);
  return { core, glow, eyes: Math.max(eyeL, eyeR2) * head };
}

function renderIcon(size) {
  const px = new Uint8ClampedArray(size * size * 4);
  const total = size * SS;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;

      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const fx = x + (sx + 0.5) / SS;
          const fy = y + (sy + 0.5) / SS;
          const tile = 1 - clamp01(roundedBox(fx, fy, size, size * 0.22) + 0.5);

          // Tile: deep space gradient with a cool top glow.
          const t = fy / size;
          let cr = mix(4, 12, t);
          let cg = mix(8, 20, t);
          let cb = mix(16, 34, t);
          const radial = 1 - clamp01(Math.hypot(fx - size * 0.32, fy - size * 0.18) / (size * 0.85));
          cr += 18 * radial;
          cg += 46 * radial;
          cb += 66 * radial;

          const mark = octomark(fx, fy, size);
          const ice = [214, 246, 255];
          const ink = [4, 18, 26];
          const fill = mark.core * (1 - mark.eyes) * 0.97 + mark.glow * 0.1;
          cr = mix(cr, ice[0], fill);
          cg = mix(cg, ice[1], fill);
          cb = mix(cb, ice[2], fill);
          const pupil = mark.eyes * 0.95;
          cr = mix(cr, ink[0], pupil);
          cg = mix(cg, ink[1], pupil);
          cb = mix(cb, ink[2], pupil);

          r += cr * tile;
          g += cg * tile;
          b += cb * tile;
          a += tile * 255;
        }
      }

      const samples = SS * SS;
      const i = (y * size + x) * 4;
      px[i] = r / samples;
      px[i + 1] = g / samples;
      px[i + 2] = b / samples;
      px[i + 3] = a / samples;
    }
  }
  return px;
}

// --- Minimal PNG encoder ---------------------------------------------------
const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

function encodePng(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter none
    Buffer.from(rgba.buffer, rgba.byteOffset + y * size * 4, size * 4).copy(
      raw,
      y * (size * 4 + 1) + 1,
    );
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function encodeIco(entries) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(entries.length, 4);
  let offset = 6 + entries.length * 16;
  const dir = [];
  for (const { size, png } of entries) {
    const e = Buffer.alloc(16);
    e[0] = size >= 256 ? 0 : size;
    e[1] = size >= 256 ? 0 : size;
    e[2] = 0;
    e[3] = 0;
    e.writeUInt16LE(1, 4);
    e.writeUInt16LE(32, 6);
    e.writeUInt32LE(png.length, 8);
    e.writeUInt32LE(offset, 12);
    dir.push(e);
    offset += png.length;
  }
  return Buffer.concat([header, ...dir, ...entries.map((e) => e.png)]);
}

const sizes = [16, 32, 48, 64, 128, 256, 512];
const pngs = new Map();
for (const size of sizes) {
  const png = encodePng(size, renderIcon(size));
  pngs.set(size, png);
  writeFileSync(resolve(outDir, `${size}.png`), png);
}

writeFileSync(resolve(outDir, "32x32.png"), pngs.get(32));
writeFileSync(resolve(outDir, "128x128.png"), pngs.get(128));
writeFileSync(resolve(outDir, "128x128@2x.png"), pngs.get(256));
writeFileSync(resolve(outDir, "icon.png"), pngs.get(512));
writeFileSync(
  resolve(outDir, "icon.ico"),
  encodeIco([16, 32, 48, 64, 128, 256].map((size) => ({ size, png: pngs.get(size) }))),
);

console.log("Wrote launcher icons to src-tauri/icons");
