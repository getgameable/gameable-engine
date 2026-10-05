#!/usr/bin/env node
/**
 * Builds the placeholder arena: a gaussian splat world, its collision mesh and
 * its spawn points. Everything here is procedural and seeded, so the committed
 * bytes are reproducible from this file alone and nothing is downloaded.
 *
 * Outputs, all written next to each other in `assets/`:
 *
 * - `arena.spz`          SPZ v2 (gzip), <= 250k gaussians, <= 4 MB.
 * - `arena.collider.bin` the matching triangle mesh; see `src/collider.ts`.
 * - `arena.spawns.json`  player / enemy / pickup spawn points.
 *
 * The world is Y-up, in metres, with the origin at the centre of the floor.
 *
 * Usage: `node scripts/gen-arena.mjs`
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

import { stringifyCompact } from './json.mjs';

// ---------------------------------------------------------------------------
// Arena dimensions. These are the single source of truth: the splats, the
// collider and the spawn points are all derived from them.
// ---------------------------------------------------------------------------

/** Half the floor size, in metres. The floor is 24 x 24 m. */
const HALF = 12;

/** Wall height, in metres. */
const WALL_H = 3;

/** Wall thickness, in metres. Walls straddle the +/- HALF lines. */
const WALL_T = 0.3;

/** Pillar half extent (square footprint), in metres. */
const PILLAR_R = 0.35;

/** Pillar centres as `[x, z]`, in metres. */
const PILLARS = [
  [-6, -6],
  [6, -6],
  [-6, 6],
  [6, 6],
  [-9, 0],
  [9, 0],
];

/** The crate: an axis-aligned box you can stand on. */
const CRATE = { min: [-6.5, 0, -5.5], max: [-3.5, 1.2, -2.5] };

/** The ramp: a wedge rising from `z = zLow` up to `height` at `z = zHigh`. */
const RAMP = { xMin: 2.5, xMax: 5.5, zLow: 6, zHigh: 2, height: 1.6 };

/** Radius of the sky dome, in metres. */
const DOME_R = 32;

/** How many faint gaussians the sky dome gets. */
const DOME_COUNT = 6000;

/** Master seed. Change it and every byte of `arena.spz` changes. */
const SEED = 0x5eed_a05;

// ---------------------------------------------------------------------------
// SPZ v2 encoding constants, mirroring three's SPZLoader.
// ---------------------------------------------------------------------------

/** `"NGSP"` little-endian: the SPZ file magic. */
const SPZ_MAGIC = 0x5053474e;

/** SPZ container version. v2 stores int24 positions and xyz quaternions. */
const SPZ_VERSION = 2;

/** Fixed-point fraction bits for positions. 12 gives 0.24 mm resolution. */
const FRACTIONAL_BITS = 12;

/** Band-0 spherical harmonic constant, as three defines it. */
const SH_C0 = 0.282_094_791_773_878_1;

/** The colour scale SPZ applies on decode. */
const SPZ_COLOR_SCALE = SH_C0 / 0.15;

// ---------------------------------------------------------------------------
// Deterministic randomness.
// ---------------------------------------------------------------------------

/**
 * Mulberry32: a tiny, fast, fully deterministic PRNG.
 *
 * @param {number} seed Any 32-bit integer.
 * @returns {() => number} A generator of floats in `[0, 1)`.
 */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

const rnd = mulberry32(SEED);

/**
 * A symmetric random offset.
 *
 * @param {number} amount Half-width of the interval.
 * @returns {number} A number in `[-amount, amount)`.
 */
function jitter(amount) {
  return (rnd() - 0.5) * 2 * amount;
}

// ---------------------------------------------------------------------------
// Splat accumulation. Parallel arrays, because 120k objects would be wasteful
// and the SPZ sections are written column-wise anyway.
// ---------------------------------------------------------------------------

/** Splat centres, flattened `xyz`. */
const centres = [];
/** Splat colours in `[0, 1]`, flattened `rgb`. */
const colours = [];
/** Splat opacities in `[0, 1]`. */
const alphas = [];
/** Splat scales in metres, flattened `xyz` (standard deviations). */
const scales = [];
/** Splat rotations, flattened `xyz` of a unit quaternion with `w >= 0`. */
const quats = [];

/**
 * Append one gaussian.
 *
 * @param {number[]} centre World position `[x, y, z]`.
 * @param {number[]} colour Linear colour `[r, g, b]` in `[0, 1]`.
 * @param {number} alpha Opacity in `[0, 1]`.
 * @param {number[]} scale Standard deviations `[x, y, z]` in metres.
 * @param {number[]} quat Unit quaternion `[x, y, z, w]`, `w >= 0` enforced here.
 * @returns {void}
 */
function addSplat(centre, colour, alpha, scale, quat) {
  centres.push(centre[0], centre[1], centre[2]);
  colours.push(colour[0], colour[1], colour[2]);
  alphas.push(alpha);
  scales.push(scale[0], scale[1], scale[2]);
  // SPZ v2 reconstructs w as +sqrt(1 - x^2 - y^2 - z^2), so a negative-w
  // quaternion has to be negated first. q and -q are the same rotation.
  const s = quat[3] < 0 ? -1 : 1;
  quats.push(s * quat[0], s * quat[1], s * quat[2]);
}

/**
 * The shortest rotation taking `+Z` to `normal`, as a unit quaternion.
 *
 * Surface splats are built in a local frame whose `z` axis is the surface
 * normal, so they can be squashed along it into thin discs.
 *
 * @param {number[]} normal Unit normal `[x, y, z]`.
 * @returns {number[]} `[x, y, z, w]`.
 */
function quatFromZTo(normal) {
  const [nx, ny, nz] = normal;
  const w = 1 + nz;
  if (w < 1e-6) return [1, 0, 0, 0]; // antipodal: a half turn about +X.
  // cross([0, 0, 1], n) = [-n.y, n.x, 0]
  const q = [-ny, nx, 0, w];
  const len = Math.hypot(q[0], q[1], q[2], q[3]);
  return [q[0] / len, q[1] / len, q[2] / len, q[3] / len];
}

/**
 * Scatter flattened disc gaussians over an axis-aligned parallelogram.
 *
 * @param {object} spec Patch description.
 * @param {number[]} spec.origin Corner of the patch, `[x, y, z]`.
 * @param {number[]} spec.u First unit tangent.
 * @param {number[]} spec.v Second unit tangent.
 * @param {number} spec.lu Extent along `u`, in metres.
 * @param {number} spec.lv Extent along `v`, in metres.
 * @param {number[]} spec.normal Unit surface normal.
 * @param {number} spec.step Nominal spacing between splats, in metres.
 * @param {(u: number, v: number, p: number[]) => number[]} spec.colour Colour at a point.
 * @param {number} [spec.alpha] Opacity, default 1.
 * @param {number} [spec.spread] In-plane standard deviation; defaults to `0.62 * step`.
 * @param {number} [spec.thick] Standard deviation along the normal, default 0.012.
 * @param {(u: number, v: number) => boolean} [spec.mask] Keep the sample when true.
 * @returns {void}
 */
function addPatch(spec) {
  const { origin, u, v, lu, lv, normal, step, colour } = spec;
  const alpha = spec.alpha ?? 1;
  const spread = spec.spread ?? step * 0.62;
  const thick = spec.thick ?? 0.012;
  const quat = quatFromZTo(normal);
  const nu = Math.max(1, Math.round(lu / step));
  const nv = Math.max(1, Math.round(lv / step));
  const du = lu / nu;
  const dv = lv / nv;

  for (let i = 0; i < nu; i += 1) {
    for (let j = 0; j < nv; j += 1) {
      const su = (i + 0.5) * du + jitter(du * 0.35);
      const sv = (j + 0.5) * dv + jitter(dv * 0.35);
      if (spec.mask && !spec.mask(su, sv)) continue;
      const n = jitter(thick * 0.5);
      const p = [
        origin[0] + u[0] * su + v[0] * sv + normal[0] * n,
        origin[1] + u[1] * su + v[1] * sv + normal[1] * n,
        origin[2] + u[2] * su + v[2] * sv + normal[2] * n,
      ];
      addSplat(p, colour(su, sv, p), alpha, [spread, spread, thick], quat);
    }
  }
}

/**
 * Tint a colour by a small deterministic amount, so flat surfaces are not
 * perfectly flat.
 *
 * @param {number[]} rgb Base colour.
 * @param {number} amount Maximum deviation per channel.
 * @returns {number[]} The tinted colour, clamped to `[0, 1]`.
 */
function speckle(rgb, amount) {
  return rgb.map((c) => Math.min(1, Math.max(0, c + jitter(amount))));
}

// ---------------------------------------------------------------------------
// The arena itself.
// ---------------------------------------------------------------------------

/** Floor colours: a 2 m checker plus a ring marking the centre. */
const FLOOR_LIGHT = [0.47, 0.48, 0.51];
const FLOOR_DARK = [0.3, 0.31, 0.35];
const ACCENT = [0.56, 0.41, 0.22];

/** Build the 24 x 24 m checkered floor. */
function buildFloor() {
  addPatch({
    origin: [-HALF, 0, -HALF],
    u: [1, 0, 0],
    v: [0, 0, 1],
    lu: HALF * 2,
    lv: HALF * 2,
    normal: [0, 1, 0],
    step: 0.09,
    colour: (su, sv, p) => {
      const radius = Math.hypot(p[0], p[2]);
      if (Math.abs(radius - 3) < 0.11) return speckle(ACCENT, 0.02);
      const tile = (Math.floor(su / 2) + Math.floor(sv / 2)) % 2;
      return speckle(tile === 0 ? FLOOR_LIGHT : FLOOR_DARK, 0.018);
    },
  });
}

/** Build the four 3 m perimeter walls, inner faces plus their caps. */
function buildWalls() {
  const inner = HALF - WALL_T / 2;
  const span = inner * 2;
  /** @type {[number[], number[], number[]][]} */
  const faces = [
    // origin, tangent along the wall, inward normal
    [
      [-inner, 0, -inner],
      [1, 0, 0],
      [0, 0, 1],
    ],
    [
      [inner, 0, inner],
      [-1, 0, 0],
      [0, 0, -1],
    ],
    [
      [-inner, 0, inner],
      [0, 0, -1],
      [1, 0, 0],
    ],
    [
      [inner, 0, -inner],
      [0, 0, 1],
      [-1, 0, 0],
    ],
  ];

  for (const [origin, tangent, normal] of faces) {
    addPatch({
      origin,
      u: tangent,
      v: [0, 1, 0],
      lu: span,
      lv: WALL_H,
      normal,
      step: 0.1,
      colour: (su, sv) => {
        // A waist-height stripe, and a floor-to-ceiling brightness ramp.
        if (sv > 2.38 && sv < 2.6) return speckle(ACCENT, 0.02);
        const k = 0.72 + 0.28 * (sv / WALL_H);
        return speckle([0.4 * k, 0.41 * k, 0.46 * k], 0.016);
      },
    });

    // The flat top of the wall, so it does not read as an infinitely thin sheet.
    addPatch({
      origin: [origin[0] - normal[0] * (WALL_T / 2), WALL_H, origin[2] - normal[2] * (WALL_T / 2)],
      u: tangent,
      v: normal,
      lu: span,
      lv: WALL_T,
      normal: [0, 1, 0],
      step: 0.09,
      colour: () => speckle([0.5, 0.5, 0.54], 0.016),
    });
  }
}

/** Build the six square pillars. */
function buildPillars() {
  for (const [cx, cz] of PILLARS) {
    /** @type {[number[], number[], number[]][]} */
    const faces = [
      [
        [cx - PILLAR_R, 0, cz + PILLAR_R],
        [1, 0, 0],
        [0, 0, 1],
      ],
      [
        [cx + PILLAR_R, 0, cz - PILLAR_R],
        [-1, 0, 0],
        [0, 0, -1],
      ],
      [
        [cx + PILLAR_R, 0, cz + PILLAR_R],
        [0, 0, -1],
        [1, 0, 0],
      ],
      [
        [cx - PILLAR_R, 0, cz - PILLAR_R],
        [0, 0, 1],
        [-1, 0, 0],
      ],
    ];
    for (const [origin, tangent, normal] of faces) {
      addPatch({
        origin,
        u: tangent,
        v: [0, 1, 0],
        lu: PILLAR_R * 2,
        lv: WALL_H,
        normal,
        step: 0.09,
        colour: (su, sv) => {
          // Horizontal banding every 40 cm.
          const band = Math.floor(sv / 0.4) % 2 === 0 ? 1 : 0.86;
          return speckle([0.54 * band, 0.5 * band, 0.45 * band], 0.02);
        },
      });
    }
    addPatch({
      origin: [cx - PILLAR_R, WALL_H, cz - PILLAR_R],
      u: [1, 0, 0],
      v: [0, 0, 1],
      lu: PILLAR_R * 2,
      lv: PILLAR_R * 2,
      normal: [0, 1, 0],
      step: 0.09,
      colour: () => speckle([0.58, 0.54, 0.48], 0.02),
    });
  }
}

/**
 * Splat the five visible faces of an axis-aligned box (the bottom is skipped).
 *
 * @param {number[]} min Minimum corner `[x, y, z]`.
 * @param {number[]} max Maximum corner `[x, y, z]`.
 * @param {number[]} rgb Base colour.
 * @param {number} step Splat spacing, in metres.
 * @returns {void}
 */
function addBoxSurface(min, max, rgb, step) {
  const dx = max[0] - min[0];
  const dy = max[1] - min[1];
  const dz = max[2] - min[2];
  const colour = () => speckle(rgb, 0.02);
  const lid = () =>
    speckle(
      rgb.map((c) => c * 1.18),
      0.02,
    );

  addPatch({
    origin: [min[0], max[1], min[2]],
    u: [1, 0, 0],
    v: [0, 0, 1],
    lu: dx,
    lv: dz,
    normal: [0, 1, 0],
    step,
    colour: lid,
  });
  addPatch({
    origin: [min[0], min[1], min[2]],
    u: [1, 0, 0],
    v: [0, 1, 0],
    lu: dx,
    lv: dy,
    normal: [0, 0, -1],
    step,
    colour,
  });
  addPatch({
    origin: [min[0], min[1], max[2]],
    u: [1, 0, 0],
    v: [0, 1, 0],
    lu: dx,
    lv: dy,
    normal: [0, 0, 1],
    step,
    colour,
  });
  addPatch({
    origin: [min[0], min[1], min[2]],
    u: [0, 0, 1],
    v: [0, 1, 0],
    lu: dz,
    lv: dy,
    normal: [-1, 0, 0],
    step,
    colour,
  });
  addPatch({
    origin: [max[0], min[1], min[2]],
    u: [0, 0, 1],
    v: [0, 1, 0],
    lu: dz,
    lv: dy,
    normal: [1, 0, 0],
    step,
    colour,
  });
}

/** Build the crate and the ramp. */
function buildProps() {
  addBoxSurface(CRATE.min, CRATE.max, [0.24, 0.42, 0.44], 0.09);

  const width = RAMP.xMax - RAMP.xMin;
  const run = RAMP.zLow - RAMP.zHigh;
  const slopeLen = Math.hypot(run, RAMP.height);
  const slopeDir = [0, RAMP.height / slopeLen, -run / slopeLen];
  const slopeNormal = [0, run / slopeLen, RAMP.height / slopeLen];
  const rampColour = () => speckle([0.45, 0.36, 0.22], 0.022);

  // The walking surface.
  addPatch({
    origin: [RAMP.xMin, 0, RAMP.zLow],
    u: [1, 0, 0],
    v: slopeDir,
    lu: width,
    lv: slopeLen,
    normal: slopeNormal,
    step: 0.09,
    colour: () => speckle([0.5, 0.4, 0.25], 0.022),
  });

  // The tall face at the top of the ramp.
  addPatch({
    origin: [RAMP.xMin, 0, RAMP.zHigh],
    u: [1, 0, 0],
    v: [0, 1, 0],
    lu: width,
    lv: RAMP.height,
    normal: [0, 0, -1],
    step: 0.09,
    colour: rampColour,
  });

  // The two triangular cheeks, cut out of a rectangle by a mask.
  const cheek = (x, normal) => {
    addPatch({
      origin: [x, 0, RAMP.zHigh],
      u: [0, 0, 1],
      v: [0, 1, 0],
      lu: run,
      lv: RAMP.height,
      normal,
      step: 0.09,
      // At distance `su` from the top, the wedge is this tall.
      mask: (su, sv) => sv <= RAMP.height * (1 - su / run),
      colour: rampColour,
    });
  };
  cheek(RAMP.xMin, [-1, 0, 0]);
  cheek(RAMP.xMax, [1, 0, 0]);
}

/** Build the sky dome: large, faint, unoriented gaussians. */
function buildDome() {
  const golden = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < DOME_COUNT; i += 1) {
    // Fibonacci hemisphere, dipped slightly below the horizon.
    const t = (i + 0.5) / DOME_COUNT;
    const y = Math.cos((t * Math.PI) / 2.12);
    const r = Math.sqrt(Math.max(0, 1 - y * y));
    const theta = i * golden;
    const radius = DOME_R + jitter(1.2);
    const p = [Math.cos(theta) * r * radius, y * radius - 2, Math.sin(theta) * r * radius];
    // Horizon haze at the bottom, deeper blue overhead.
    const k = Math.min(1, Math.max(0, y));
    const colour = speckle([0.62 - 0.3 * k, 0.68 - 0.24 * k, 0.78 - 0.1 * k], 0.02);
    const s = 2.1 + rnd() * 0.9;
    addSplat(p, colour, 0.1 + rnd() * 0.05, [s, s, s], [0, 0, 0, 1]);
  }
}

// ---------------------------------------------------------------------------
// SPZ v2 writer, ported from the rendering spike's `gen_spz.mjs`. The layout is
// the exact inverse of SPZLoader.parseRawSPZ.
// ---------------------------------------------------------------------------

/**
 * Clamp to a byte.
 *
 * @param {number} v Any number.
 * @returns {number} An integer in `[0, 255]`.
 */
function clamp255(v) {
  return Math.max(0, Math.min(255, Math.round(v)));
}

/**
 * Encode a linear colour channel. Inverse of SPZLoader's `COLOR_LUT`.
 *
 * @param {number} linear Channel value in `[0, 1]`.
 * @returns {number} The stored byte.
 */
function encodeColour(linear) {
  return clamp255(((linear - 0.5) / SPZ_COLOR_SCALE + 0.5) * 255);
}

/**
 * Encode a standard deviation. Inverse of SPZLoader's `SCALE_LUT`.
 *
 * @param {number} metres Standard deviation in metres, strictly positive.
 * @returns {number} The stored byte.
 */
function encodeScale(metres) {
  return clamp255((Math.log(metres) + 10) * 16);
}

/**
 * Write a little-endian signed 24-bit integer.
 *
 * @param {Buffer} buf Destination.
 * @param {number} offset Byte offset.
 * @param {number} value Integer in `[-2^23, 2^23)`.
 * @returns {void}
 */
function writeInt24(buf, offset, value) {
  const x = value & 0xff_ff_ff;
  buf[offset] = x & 0xff;
  buf[offset + 1] = (x >> 8) & 0xff;
  buf[offset + 2] = (x >> 16) & 0xff;
}

/**
 * Serialise the accumulated splats as a gzipped SPZ v2 file.
 *
 * @returns {Buffer} The compressed `.spz` bytes.
 */
function encodeSpz() {
  const count = alphas.length;
  if (count > 250_000) throw new Error(`too many splats: ${String(count)} > 250000`);

  const header = Buffer.alloc(16);
  header.writeUInt32LE(SPZ_MAGIC, 0);
  header.writeUInt32LE(SPZ_VERSION, 4);
  header.writeUInt32LE(count, 8);
  header.writeUInt8(0, 12); // stored SH degree: band 0 only
  header.writeUInt8(FRACTIONAL_BITS, 13);
  header.writeUInt8(0, 14); // flags: no LOD
  header.writeUInt8(0, 15);

  const positionBytes = Buffer.alloc(count * 9);
  const alphaBytes = Buffer.alloc(count);
  const colourBytes = Buffer.alloc(count * 3);
  const scaleBytes = Buffer.alloc(count * 3);
  const rotationBytes = Buffer.alloc(count * 3);
  const fixed = 1 << FRACTIONAL_BITS;

  for (let i = 0; i < count; i += 1) {
    const i3 = i * 3;
    const i9 = i * 9;
    writeInt24(positionBytes, i9, Math.round(centres[i3] * fixed));
    writeInt24(positionBytes, i9 + 3, Math.round(centres[i3 + 1] * fixed));
    writeInt24(positionBytes, i9 + 6, Math.round(centres[i3 + 2] * fixed));

    alphaBytes[i] = clamp255(alphas[i] * 255);

    colourBytes[i3] = encodeColour(colours[i3]);
    colourBytes[i3 + 1] = encodeColour(colours[i3 + 1]);
    colourBytes[i3 + 2] = encodeColour(colours[i3 + 2]);

    scaleBytes[i3] = encodeScale(scales[i3]);
    scaleBytes[i3 + 1] = encodeScale(scales[i3 + 1]);
    scaleBytes[i3 + 2] = encodeScale(scales[i3 + 2]);

    rotationBytes[i3] = clamp255((quats[i3] + 1) * 127.5);
    rotationBytes[i3 + 1] = clamp255((quats[i3 + 1] + 1) * 127.5);
    rotationBytes[i3 + 2] = clamp255((quats[i3 + 2] + 1) * 127.5);
  }

  const raw = Buffer.concat([
    header,
    positionBytes,
    alphaBytes,
    colourBytes,
    scaleBytes,
    rotationBytes,
  ]);
  const expected = 16 + count * 19;
  if (raw.length !== expected) {
    throw new Error(`SPZ size mismatch: ${String(raw.length)} != ${String(expected)}`);
  }
  // Level 9: this file is committed, so spend the time once.
  return gzipSync(raw, { level: 9 });
}

// ---------------------------------------------------------------------------
// Collision mesh. Boxes and one wedge; see `src/collider.ts` for the format.
// ---------------------------------------------------------------------------

/** Collider vertex positions, flattened `xyz`. */
const colliderPositions = [];
/** Collider triangle indices. */
const colliderIndices = [];

/**
 * Append a vertex and return its index.
 *
 * @param {number} x X in metres.
 * @param {number} y Y in metres.
 * @param {number} z Z in metres.
 * @returns {number} The new vertex index.
 */
function vertex(x, y, z) {
  const index = colliderPositions.length / 3;
  colliderPositions.push(x, y, z);
  return index;
}

/**
 * Append a triangle, wound counter-clockwise when seen from outside.
 *
 * @param {number} a First vertex index.
 * @param {number} b Second vertex index.
 * @param {number} c Third vertex index.
 * @returns {void}
 */
function triangle(a, b, c) {
  colliderIndices.push(a, b, c);
}

/**
 * Append a quad as two triangles.
 *
 * @param {number} a First vertex index.
 * @param {number} b Second vertex index.
 * @param {number} c Third vertex index.
 * @param {number} d Fourth vertex index.
 * @returns {void}
 */
function quad(a, b, c, d) {
  triangle(a, b, c);
  triangle(a, c, d);
}

/**
 * Append a closed axis-aligned box: 8 vertices, 12 triangles.
 *
 * @param {number[]} min Minimum corner `[x, y, z]`.
 * @param {number[]} max Maximum corner `[x, y, z]`.
 * @returns {void}
 */
function colliderBox(min, max) {
  const [x0, y0, z0] = min;
  const [x1, y1, z1] = max;
  const v000 = vertex(x0, y0, z0);
  const v100 = vertex(x1, y0, z0);
  const v110 = vertex(x1, y1, z0);
  const v010 = vertex(x0, y1, z0);
  const v001 = vertex(x0, y0, z1);
  const v101 = vertex(x1, y0, z1);
  const v111 = vertex(x1, y1, z1);
  const v011 = vertex(x0, y1, z1);
  quad(v001, v101, v111, v011); // +Z
  quad(v100, v000, v010, v110); // -Z
  quad(v101, v100, v110, v111); // +X
  quad(v000, v001, v011, v010); // -X
  quad(v010, v011, v111, v110); // +Y
  quad(v000, v100, v101, v001); // -Y
}

/** Build the whole collision mesh. */
function buildCollider() {
  // Floor.
  const f0 = vertex(-HALF, 0, -HALF);
  const f1 = vertex(HALF, 0, -HALF);
  const f2 = vertex(HALF, 0, HALF);
  const f3 = vertex(-HALF, 0, HALF);
  quad(f0, f1, f2, f3);

  // Walls, straddling the perimeter so the playable area is exactly 24 x 24 m
  // minus the inner half-thickness.
  const t = WALL_T / 2;
  colliderBox([-HALF - t, 0, -HALF - t], [HALF + t, WALL_H, -HALF + t]);
  colliderBox([-HALF - t, 0, HALF - t], [HALF + t, WALL_H, HALF + t]);
  colliderBox([-HALF - t, 0, -HALF - t], [-HALF + t, WALL_H, HALF + t]);
  colliderBox([HALF - t, 0, -HALF - t], [HALF + t, WALL_H, HALF + t]);

  // Pillars.
  for (const [cx, cz] of PILLARS) {
    colliderBox([cx - PILLAR_R, 0, cz - PILLAR_R], [cx + PILLAR_R, WALL_H, cz + PILLAR_R]);
  }

  // Crate.
  colliderBox(CRATE.min, CRATE.max);

  // Ramp: a triangular prism, 6 vertices and 8 triangles.
  const { xMin, xMax, zLow, zHigh, height } = RAMP;
  const a = vertex(xMin, 0, zLow);
  const b = vertex(xMax, 0, zLow);
  const c = vertex(xMax, height, zHigh);
  const d = vertex(xMin, height, zHigh);
  const e = vertex(xMin, 0, zHigh);
  const f = vertex(xMax, 0, zHigh);
  quad(a, b, c, d); // the slope
  quad(d, c, f, e); // the tall face at the top
  quad(e, f, b, a); // the underside
  triangle(a, d, e); // -X cheek
  triangle(b, f, c); // +X cheek
}

/**
 * Serialise the collision mesh.
 *
 * @returns {Buffer} `u32 vertexCount, u32 indexCount, f32 positions[], u32 indices[]`.
 */
function encodeColliderFile() {
  const vertexCount = colliderPositions.length / 3;
  const indexCount = colliderIndices.length;
  const buf = Buffer.alloc(8 + vertexCount * 12 + indexCount * 4);
  buf.writeUInt32LE(vertexCount, 0);
  buf.writeUInt32LE(indexCount, 4);
  let offset = 8;
  for (const value of colliderPositions) {
    buf.writeFloatLE(value, offset);
    offset += 4;
  }
  for (const index of colliderIndices) {
    buf.writeUInt32LE(index, offset);
    offset += 4;
  }
  return buf;
}

// ---------------------------------------------------------------------------
// Spawn points.
// ---------------------------------------------------------------------------

/**
 * Round to four decimals, so the committed JSON is stable and readable.
 *
 * @param {number} v Any number.
 * @returns {number} The rounded number.
 */
function round4(v) {
  return Math.round(v * 1e4) / 1e4;
}

/**
 * A spawn point that looks at the centre of the arena.
 *
 * With three's convention (`rotation.y`, forward `-Z`) the yaw that faces the
 * origin from `[x, ?, z]` is `atan2(x, z)`.
 *
 * @param {number} x X in metres.
 * @param {number} y Y in metres.
 * @param {number} z Z in metres.
 * @returns {{ position: number[], yaw: number }} The spawn point.
 */
function facingCentre(x, y, z) {
  return { position: [round4(x), round4(y), round4(z)], yaw: round4(Math.atan2(x, z)) };
}

/**
 * Build the spawn table.
 *
 * @returns {object} The `arena.spawns.json` document.
 */
function buildSpawns() {
  return {
    generatedBy: 'packages/assets-placeholder/scripts/gen-arena.mjs',
    units: 'metres',
    up: '+Y',
    yawConvention: 'radians about +Y; 0 looks down -Z, matching three.js rotation.y',
    bounds: { min: [-HALF, 0, -HALF], max: [HALF, WALL_H, HALF] },
    player: facingCentre(0, 0, 9),
    enemies: [
      facingCentre(-9.5, 0, -9.5),
      facingCentre(9.5, 0, -9.5),
      facingCentre(-9.5, 0, 9.5),
      facingCentre(9.5, 0, 9.5),
      facingCentre(0, 0, -10.5),
      facingCentre(3, 0, -2),
    ],
    pickups: [facingCentre(0, 1, 0), facingCentre(-8.5, 1, -8.5), facingCentre(8.5, 1, 8.5)],
  };
}

// ---------------------------------------------------------------------------
// Main.
// ---------------------------------------------------------------------------

const outDir = fileURLToPath(new URL('../assets/', import.meta.url));
mkdirSync(outDir, { recursive: true });

buildFloor();
buildWalls();
buildPillars();
buildProps();
buildDome();
buildCollider();

const spz = encodeSpz();
writeFileSync(`${outDir}arena.spz`, spz);

const collider = encodeColliderFile();
writeFileSync(`${outDir}arena.collider.bin`, collider);

const spawns = buildSpawns();
writeFileSync(`${outDir}arena.spawns.json`, `${stringifyCompact(spawns)}\n`);

if (spz.length > 4 * 1024 * 1024) {
  throw new Error(`arena.spz is ${String(spz.length)} bytes, over the 4 MB budget`);
}

console.log(
  `arena.spz            ${String(alphas.length).padStart(7)} splats  ${(spz.length / 1e6).toFixed(2)} MB`,
);
console.log(
  `arena.collider.bin   ${String(colliderPositions.length / 3).padStart(7)} verts   ${String(
    colliderIndices.length / 3,
  )} tris`,
);
console.log(
  `arena.spawns.json    1 player, ${String(spawns.enemies.length)} enemies, ${String(
    spawns.pickups.length,
  )} pickups`,
);
