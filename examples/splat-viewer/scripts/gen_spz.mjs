#!/usr/bin/env node
/**
 * Writes a synthetic SPZ v2 file, so the example has a splat to render without a binary in
 * the repository.
 *
 * The layout is the exact inverse of `SPZLoader.parseRawSPZ`. Generated rather than committed
 * because a real capture is tens of megabytes, would need Git LFS, and would make a clean
 * clone fail for anyone who has not installed it — `predev` and `prebuild` regenerate this
 * file, so `npm run dev` works from a bare checkout.
 *
 * The output is deterministic (a fixed LCG seed), which is what makes the Playwright
 * screenshot golden stable.
 *
 * Usage: `node scripts/gen_spz.mjs [count] [outfile]`
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';

const count = Number(process.argv[2] ?? 150000);
const out = resolve(process.argv[3] ?? `public/models/synthetic_${String(count)}.spz`);

if (existsSync(out) && process.env.FORCE !== '1') {
  console.log(`gen_spz: ${out} exists, leaving it alone (FORCE=1 to regenerate)`);
  process.exit(0);
}

const SPZ_MAGIC = 0x5053474e; // "NGSP"
const VERSION = 2;
const FRACTIONAL_BITS = 12;
const SH_C0 = 0.2820947917738781;
const SPZ_COLOR_SCALE = SH_C0 / 0.15; // SPZLoader.js:13

let seed = 0x2545f491;
/** Deterministic LCG in [0, 1). @returns {number} The next value. */
const rnd = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296;

const header = Buffer.alloc(16);
header.writeUInt32LE(SPZ_MAGIC, 0);
header.writeUInt32LE(VERSION, 4);
header.writeUInt32LE(count, 8);
header.writeUInt8(0, 12); // stored SH degree: 0, flat colour
header.writeUInt8(FRACTIONAL_BITS, 13);
header.writeUInt8(0, 14); // flags: no LOD
header.writeUInt8(0, 15);

const positions = Buffer.alloc(count * 9); // 3 x int24 LE
const alphas = Buffer.alloc(count);
const colors = Buffer.alloc(count * 3);
const scales = Buffer.alloc(count * 3);
const rotations = Buffer.alloc(count * 3); // xyz; w is reconstructed as +sqrt(1 - x² - y² - z²)

/**
 * Write a 24-bit little-endian integer.
 *
 * @param {Buffer} buf Target.
 * @param {number} offset Byte offset.
 * @param {number} value Value; only the low 24 bits are used.
 * @returns {void}
 */
const writeInt24 = (buf, offset, value) => {
  const x = value & 0xffffff;
  buf[offset] = x & 0xff;
  buf[offset + 1] = (x >> 8) & 0xff;
  buf[offset + 2] = (x >> 16) & 0xff;
};

/** @param {number} v @returns {number} v clamped and rounded into a byte. */
const clamp255 = (v) => Math.max(0, Math.min(255, Math.round(v)));
// Inverse of SPZLoader's COLOR_LUT: ((b / 255 - 0.5) * SPZ_COLOR_SCALE + 0.5) * 255
const encodeColor = (linear) => clamp255(((linear - 0.5) / SPZ_COLOR_SCALE + 0.5) * 255);
// Inverse of SPZLoader's SCALE_LUT: exp(b / 16 - 10)
const encodeScale = (metres) => clamp255((Math.log(metres) + 10) * 16);

const F = 1 << FRACTIONAL_BITS;

for (let i = 0; i < count; i += 1) {
  const o3 = i * 3;
  const o9 = i * 9;

  // A hollow-ish shell plus a floor slab, so the render has recognisable structure rather
  // than a uniform fog: a screenshot golden of uniform noise tells you nothing when it fails.
  const onFloor = i % 4 === 0;
  let x;
  let y;
  let z;
  if (onFloor) {
    x = (rnd() - 0.5) * 9;
    z = (rnd() - 0.5) * 9;
    y = -2.4 + rnd() * 0.15;
  } else {
    const theta = rnd() * Math.PI * 2;
    const phi = Math.acos(2 * rnd() - 1);
    const r = 3.2 + rnd() * 0.35;
    x = r * Math.sin(phi) * Math.cos(theta);
    y = r * Math.cos(phi) * 0.75;
    z = r * Math.sin(phi) * Math.sin(theta);
  }

  writeInt24(positions, o9 + 0, Math.round(x * F));
  writeInt24(positions, o9 + 3, Math.round(y * F));
  writeInt24(positions, o9 + 6, Math.round(z * F));

  // Colour by height, so orientation is readable in a screenshot.
  const t = Math.min(1, Math.max(0, (y + 3) / 6));
  colors[o3 + 0] = encodeColor(0.25 + 0.55 * t);
  colors[o3 + 1] = encodeColor(0.35 + 0.35 * (1 - t));
  colors[o3 + 2] = encodeColor(0.55 + 0.35 * t);
  alphas[i] = clamp255(255 * (0.55 + 0.3 * rnd()));

  const s = onFloor ? 0.03 + 0.02 * rnd() : 0.012 + 0.018 * rnd();
  scales[o3 + 0] = encodeScale(s);
  scales[o3 + 1] = encodeScale(onFloor ? s * 0.3 : s);
  scales[o3 + 2] = encodeScale(s);

  // Uniform random rotation with w >= 0; SPZ v2 always reconstructs a positive w.
  const u1 = rnd();
  const u2 = rnd();
  const u3 = rnd();
  const a = Math.sqrt(1 - u1);
  const b = Math.sqrt(u1);
  let qx = a * Math.sin(2 * Math.PI * u2);
  let qy = a * Math.cos(2 * Math.PI * u2);
  let qz = b * Math.sin(2 * Math.PI * u3);
  const qw = b * Math.cos(2 * Math.PI * u3);
  if (qw < 0) {
    qx = -qx;
    qy = -qy;
    qz = -qz;
  }
  rotations[o3 + 0] = clamp255((qx + 1) * 127.5);
  rotations[o3 + 1] = clamp255((qy + 1) * 127.5);
  rotations[o3 + 2] = clamp255((qz + 1) * 127.5);
}

const raw = Buffer.concat([header, positions, alphas, colors, scales, rotations]);
const expected = 16 + count * 9 + count + count * 3 + count * 3 + count * 3;
if (raw.length !== expected) throw new Error(`size mismatch ${raw.length} != ${expected}`);

const gz = gzipSync(raw, { level: 6 });
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, gz);
console.log(
  `gen_spz: wrote ${out} - ${count} gaussians, raw ${(raw.length / 1e6).toFixed(1)} MB -> gzip ${(
    gz.length / 1e6
  ).toFixed(1)} MB`,
);
