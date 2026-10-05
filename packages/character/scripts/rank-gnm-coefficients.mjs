#!/usr/bin/env node
/**
 * Rank a GNM expression basis by what each coefficient actually MOVES.
 *
 * WHY THIS EXISTS. `head_ext` is 383 standardised latents with no names and no
 * documented semantics: nothing in the pack says which coefficient is a blink. The real
 * ARKit -> GNM map will ship with the retrained decoders as `arkit_to_gnm.json`; until
 * then `src/expression/arkitToGnmDefault.ts` is a hand-authored stopgap, and this script
 * is how its numbers were found rather than guessed.
 *
 * HOW. Each coefficient's basis row is a per-vertex displacement field. Anatomical
 * regions are cut out of the NEUTRAL mesh geometrically — the eye joints' own positions
 * give the eyes, and the brow, mouth-corner and jaw bands are offsets from them — and
 * every coefficient is then scored inside each region by how far it moves those vertices
 * and in which direction. A blink is "the coefficient that moves the upper lid DOWN and
 * moves little else"; a jaw drop is "moves the chin DOWN"; a smile is "moves the mouth
 * corners OUTWARD and UP".
 *
 * The regions are measured off myra's neutral head (eyes at y ~= 0.300 m, mouth band at
 * y ~= 0.22 m) and are therefore approximate for another identity. That is fine for a
 * stopgap and is exactly why the output is reviewed by a human and pasted into a table
 * rather than loaded at runtime.
 *
 * Usage:
 *   node packages/character/scripts/rank-gnm-coefficients.mjs <pack.aosrig> [--top 6] [--json]
 */
import { readFileSync } from 'node:fs';

const MAGIC = 'AOSRIG01';

/**
 * Parse just enough of an `.aosrig` pack: the header and the blobs this script reads.
 *
 * A second parser next to `src/rig/gnm/gnmPack.ts` is deliberate — this is a node script
 * that must run with no build step and no TypeScript loader, and it reads four blobs.
 *
 * @param {Buffer} buffer The whole pack.
 * @returns {{header: object, blob: (name: string) => {entry: object, bytes: Buffer}}} The
 *   header plus a blob accessor.
 */
function parsePack(buffer) {
  if (buffer.subarray(0, 8).toString('latin1') !== MAGIC) {
    throw new Error(`not an .aosrig pack (magic is "${buffer.subarray(0, 8).toString('latin1')}")`);
  }
  const headerLen = buffer.readUInt32LE(8);
  const header = JSON.parse(buffer.subarray(16, 16 + headerLen).toString('utf8'));
  const byName = new Map(header.buffers.map((b) => [b.name, b]));
  return {
    header,
    blob(name) {
      const entry = byName.get(name);
      if (entry === undefined) throw new Error(`pack has no "${name}" blob`);
      return { entry, bytes: buffer.subarray(entry.offset, entry.offset + entry.byteLength) };
    },
  };
}

/**
 * Widen one IEEE-754 half.
 *
 * @param {number} half The raw 16 bits.
 * @returns {number} The value.
 */
function halfToFloat(half) {
  const sign = (half & 0x8000) >> 15;
  const exponent = (half & 0x7c00) >> 10;
  const fraction = half & 0x03ff;
  let value;
  if (exponent === 0) value = fraction * 2 ** -24;
  else if (exponent === 0x1f) value = fraction ? NaN : Infinity;
  else value = (fraction / 1024 + 1) * 2 ** (exponent - 15);
  return sign ? -value : value;
}

/**
 * The anatomical vertex masks, cut out of the neutral mesh.
 *
 * @param {Float32Array} neutral `(V,3)` metres.
 * @param {Float32Array} eyePositions `(2,3)` — left then right.
 * @param {Float32Array} eyeWeights `(2,V)`.
 * @param {number} V Vertex count.
 * @returns {Record<string, number[]>} Vertex indices per region name.
 */
function regionMasks(neutral, eyePositions, eyeWeights, V) {
  const eye = (e, axis) => eyePositions[e * 3 + axis];
  const masks = {
    lidUpperL: [],
    lidUpperR: [],
    lidLowerL: [],
    lidLowerR: [],
    browL: [],
    browR: [],
    mouthCornerL: [],
    mouthCornerR: [],
    mouthCentre: [],
    jaw: [],
  };
  const eyeY = (eye(0, 1) + eye(1, 1)) / 2;
  for (let v = 0; v < V; v++) {
    const x = neutral[v * 3];
    const y = neutral[v * 3 + 1];
    const z = neutral[v * 3 + 2];
    const isEyeball = Math.max(eyeWeights[v], eyeWeights[V + v]) > 0.5;

    for (const e of [0, 1]) {
      const dx = x - eye(e, 0);
      const dy = y - eye(e, 1);
      const dz = z - eye(e, 2);
      const r = Math.hypot(dx, dy, dz);
      // The lids: a shell around the eyeball, the eyeball itself excluded.
      if (!isEyeball && r < 0.026) {
        const side = e === 0 ? 'L' : 'R';
        if (dy >= 0.002) masks[`lidUpper${side}`].push(v);
        else if (dy <= -0.002) masks[`lidLower${side}`].push(v);
      }
    }

    // The brow band sits 2.5-5.5 cm above the eye line, on the front of the head.
    if (y > eyeY + 0.025 && y < eyeY + 0.055 && Math.abs(x) < 0.075 && z > 0.055) {
      (x > 0 ? masks.browL : masks.browR).push(v);
    }
    // The mouth band, measured from the lower_face displacement centroid (y ~= 0.232).
    if (y > 0.205 && y < 0.245 && z > 0.075) {
      if (Math.abs(x) > 0.021 && Math.abs(x) < 0.055) {
        (x > 0 ? masks.mouthCornerL : masks.mouthCornerR).push(v);
      } else if (Math.abs(x) <= 0.021) {
        masks.mouthCentre.push(v);
      }
    }
    // The chin and jaw line, below the mouth.
    if (y > 0.15 && y < 0.2 && Math.abs(x) < 0.05 && z > 0.05) masks.jaw.push(v);
  }
  return masks;
}

/**
 * Score every coefficient inside every region.
 *
 * @param {(c: number, v: number, k: number) => number} basisAt Basis accessor, metres.
 * @param {number} E Coefficient count.
 * @param {number} V Vertex count.
 * @param {Float32Array} neutral `(V,3)`, for the outward direction.
 * @param {Record<string, number[]>} masks Region masks.
 * @returns {Record<string, {c: number, mag: number, dy: number, out: number, dz: number,
 *   focus: number}[]>} Per region, one row per coefficient.
 */
function score(basisAt, E, V, neutral, masks) {
  // Whole-mesh magnitude per coefficient, for the focus ratio.
  const whole = new Float64Array(E);
  for (let c = 0; c < E; c++) {
    let sum = 0;
    for (let v = 0; v < V; v++) {
      sum += Math.hypot(basisAt(c, v, 0), basisAt(c, v, 1), basisAt(c, v, 2));
    }
    whole[c] = sum / V;
  }

  const out = {};
  for (const [region, ids] of Object.entries(masks)) {
    const rows = [];
    for (let c = 0; c < E; c++) {
      let mag = 0;
      let dy = 0;
      let outward = 0;
      let dz = 0;
      for (const v of ids) {
        const bx = basisAt(c, v, 0);
        const by = basisAt(c, v, 1);
        const bz = basisAt(c, v, 2);
        mag += Math.hypot(bx, by, bz);
        dy += by;
        dz += bz;
        outward += Math.sign(neutral[v * 3]) * bx;
      }
      const n = Math.max(1, ids.length);
      rows.push({
        c,
        mag: mag / n,
        dy: dy / n,
        out: outward / n,
        dz: dz / n,
        focus: whole[c] > 0 ? mag / n / whole[c] : 0,
      });
    }
    out[region] = rows;
  }
  return out;
}

/** The behaviours the ARKit map needs, as a scoring rule over the region tables. */
const TARGETS = [
  { name: 'blinkL (upper lid down)', region: 'lidUpperL', pick: (r) => -r.dy * r.focus },
  { name: 'blinkR (upper lid down)', region: 'lidUpperR', pick: (r) => -r.dy * r.focus },
  { name: 'squintL (lower lid up)', region: 'lidLowerL', pick: (r) => r.dy * r.focus },
  { name: 'squintR (lower lid up)', region: 'lidLowerR', pick: (r) => r.dy * r.focus },
  { name: 'browUpL', region: 'browL', pick: (r) => r.dy * r.focus },
  { name: 'browUpR', region: 'browR', pick: (r) => r.dy * r.focus },
  { name: 'browDownL', region: 'browL', pick: (r) => -r.dy * r.focus },
  { name: 'browDownR', region: 'browR', pick: (r) => -r.dy * r.focus },
  { name: 'jawOpen (chin down)', region: 'jaw', pick: (r) => -r.dy * r.focus },
  { name: 'mouthCentre open (lips apart)', region: 'mouthCentre', pick: (r) => -r.dy * r.focus },
  { name: 'smileL (corner out+up)', region: 'mouthCornerL', pick: (r) => (r.out + r.dy) * r.focus },
  { name: 'smileR (corner out+up)', region: 'mouthCornerR', pick: (r) => (r.out + r.dy) * r.focus },
  {
    name: 'frownL (corner in+down)',
    region: 'mouthCornerL',
    pick: (r) => (-r.out - r.dy) * r.focus,
  },
  {
    name: 'frownR (corner in+down)',
    region: 'mouthCornerR',
    pick: (r) => (-r.out - r.dy) * r.focus,
  },
  { name: 'pucker (lips forward)', region: 'mouthCentre', pick: (r) => r.dz * r.focus },
];

const args = process.argv.slice(2);
const packPath = args.find((a) => !a.startsWith('--'));
const top = Number(args[args.indexOf('--top') + 1]) || 6;
const asJson = args.includes('--json');
if (packPath === undefined) {
  console.error('usage: rank-gnm-coefficients.mjs <pack.aosrig> [--top N] [--json]');
  process.exit(2);
}

const pack = parsePack(readFileSync(packPath));
const { header } = pack;
const V = header.vertexCount;
const E = header.coeffCount;

const neutralBlob = pack.blob('neutral');
const neutral = new Float32Array(
  neutralBlob.bytes.buffer.slice(
    neutralBlob.bytes.byteOffset,
    neutralBlob.bytes.byteOffset + neutralBlob.bytes.byteLength,
  ),
);
const basisBlob = pack.blob('basis');
const basisWords = new Uint32Array(
  basisBlob.bytes.buffer.slice(
    basisBlob.bytes.byteOffset,
    basisBlob.bytes.byteOffset + basisBlob.bytes.byteLength,
  ),
);
const scaleBlob = pack.blob('basisScale');
const basisScale = new Float32Array(
  scaleBlob.bytes.buffer.slice(
    scaleBlob.bytes.byteOffset,
    scaleBlob.bytes.byteOffset + scaleBlob.bytes.byteLength,
  ),
);
const eyePosBlob = pack.blob('eyePositions');
const eyePositions = new Float32Array(
  eyePosBlob.bytes.buffer.slice(
    eyePosBlob.bytes.byteOffset,
    eyePosBlob.bytes.byteOffset + eyePosBlob.bytes.byteLength,
  ),
);
const eyeWBlob = pack.blob('eyeWeights');
const eyeWeights = new Float32Array(
  eyeWBlob.bytes.buffer.slice(
    eyeWBlob.bytes.byteOffset,
    eyeWBlob.bytes.byteOffset + eyeWBlob.bytes.byteLength,
  ),
);

/**
 * One basis component, dequantised — vertex-major `(V,E,3)` fp16 pairs in u32 words.
 *
 * @param {number} c Coefficient.
 * @param {number} v Vertex.
 * @param {number} k Component 0..2.
 * @returns {number} Metres.
 */
function basisAt(c, v, k) {
  const lane = (v * E + c) * 3 + k;
  const word = basisWords[lane >>> 1];
  const half = (lane & 1) === 1 ? word >>> 16 : word & 0xffff;
  return halfToFloat(half) * basisScale[c];
}

const masks = regionMasks(neutral, eyePositions, eyeWeights, V);
const tables = score(basisAt, E, V, neutral, masks);

/**
 * Which `head_ext` region a coefficient index falls in.
 *
 * @param {number} c Coefficient index.
 * @returns {string} `"<region>[+k]"`.
 */
function regionOf(c) {
  let start = 0;
  for (const [name, n] of header.headExt.regions) {
    if (c < start + n) return `${name}+${String(c - start)}`;
    start += n;
  }
  return '?';
}

const report = {};
for (const target of TARGETS) {
  const rows = tables[target.region];
  const ranked = [...rows].sort((a, b) => target.pick(b) - target.pick(a)).slice(0, top);
  report[target.name] = ranked.map((r) => ({
    coefficient: r.c,
    block: regionOf(r.c),
    score: Number(target.pick(r).toFixed(6)),
    regionMeanDisplacementMm: Number((r.mag * 1000).toFixed(4)),
    dyMm: Number((r.dy * 1000).toFixed(4)),
    outwardMm: Number((r.out * 1000).toFixed(4)),
    forwardMm: Number((r.dz * 1000).toFixed(4)),
    focus: Number(r.focus.toFixed(2)),
  }));
}

if (asJson) {
  console.log(JSON.stringify({ pack: packPath, vertexCount: V, coeffCount: E, report }, null, 2));
} else {
  console.log(`${packPath}: V=${String(V)} E=${String(E)}`);
  console.log(
    `masks: ${Object.entries(masks)
      .map(([k, v]) => `${k}=${String(v.length)}`)
      .join(' ')}`,
  );
  for (const [name, rows] of Object.entries(report)) {
    console.log(`\n${name}`);
    console.log('   coeff  block            score      |d| mm    dy mm    out mm   fwd mm  focus');
    for (const r of rows) {
      console.log(
        `  ${String(r.coefficient).padStart(5)}  ${r.block.padEnd(15)} ${String(r.score).padStart(9)} ` +
          `${String(r.regionMeanDisplacementMm).padStart(9)} ${String(r.dyMm).padStart(8)} ` +
          `${String(r.outwardMm).padStart(9)} ${String(r.forwardMm).padStart(8)} ${String(r.focus).padStart(6)}`,
      );
    }
  }
}
