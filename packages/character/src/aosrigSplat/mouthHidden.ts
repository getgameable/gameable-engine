/**
 * The closed mouth's inside, as data: `mouth_hidden.bin` beside a package's files. A splat of
 * a closed mouth is a cloud of points centimetres deep behind the lips; when the lips part,
 * the cloud's inner points come out as streaks across the opening, in front of the teeth. The
 * studio lists the points the opening takes away (the ones near the lips' rim or inside the
 * mouth bag that cannot be seen at rest, and the lip line's dark plugs that straddle it),
 * each with the two lip vertices of the head model above and below it.
 *
 * Each frame, per listed splat: the lips' gap there is how far its two lip vertices have parted
 * past rest, `max(0, ((upper − lower) − (upper₀ − lower₀)) · up)` from the expressed head and
 * the head at rest (the two vertices need not touch at rest: an inside point's are the rim
 * above and below it), and the splat's opacity is multiplied by `1 − smoothstep(0.5 mm, 2 mm, gap)`:
 * whole while the lips touch, gone once they are 2 mm apart. A plug (kind 1) also sits half
 * way between its two lip vertices (its own place plus half their moves) and is pushed back
 * along the head's forward by `3 mm · smoothstep(0, 2 mm, gap) + gap / 4` (at most 7.5 mm of
 * the second part). An inside point (kind 2) keeps its place and only fades. A splat of the
 * lips' band (kind 3, within 8 mm of the lip line and neither of those) is never faded: as the
 * lips part there its three sizes are capped at 2.5 mm by the same ramp, so no point of the
 * lips reaches across the opening as a streak.
 *
 * No GPU here; `runtime.ts` packs the lanes and `boundSplatNode.ts` applies the rule.
 */

/** The file's fixed header: magic, count, up, forward. */
const HEADER = 36;
const MAGIC = 'AOSMHD01';

/** The listed splats, parsed. */
export interface MouthHidden {
  count: number;
  /** How many are the lip line's plugs (kind 1), and how many the lips' band (kind 3); the rest are inside points (kind 2). */
  plugs: number;
  band: number;
  /** The head's up and forward, unit, in the character's frame. */
  up: [number, number, number];
  forward: [number, number, number];
  /** Per listed splat: its row in `character.ply`, its kind, its upper and lower lip vertex. */
  row: Uint32Array;
  kind: Uint8Array;
  upper: Uint32Array;
  lower: Uint32Array;
}

/**
 * Parse `mouth_hidden.bin`.
 *
 * @param bytes The file.
 * @param splatCount The character's splat count (rows must be under it).
 * @param headVertexCount The head model's vertex count (the lip vertices must be under it).
 * @returns The list.
 * @throws {Error} On a bad magic or size, a row or vertex out of range, a kind that is not
 *   1, 2 or 3, a row listed twice, or an up or forward that is not a direction.
 */
export function parseMouthHidden(
  bytes: Uint8Array,
  splatCount: number,
  headVertexCount: number,
): MouthHidden {
  const bad = (what: string): never => {
    throw new Error(`aosrig-splat: mouth_hidden.bin ${what}`);
  };
  if (bytes.length < HEADER || new TextDecoder().decode(bytes.subarray(0, 8)) !== MAGIC)
    bad('is not a hidden-points list');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = view.getUint32(8, true);
  if (count < 1 || count > splatCount || bytes.length !== HEADER + count * 16)
    bad('has the wrong size');
  const axis = (at: number): [number, number, number] => {
    const v: [number, number, number] = [
      view.getFloat32(at, true),
      view.getFloat32(at + 4, true),
      view.getFloat32(at + 8, true),
    ];
    const len = Math.hypot(...v);
    if (!v.every(Number.isFinite) || len < 0.5 || len > 2)
      bad('has an up or forward that is not a direction');
    return [v[0] / len, v[1] / len, v[2] / len];
  };
  const up = axis(12);
  const forward = axis(24);
  const row = new Uint32Array(count),
    kind = new Uint8Array(count),
    upper = new Uint32Array(count),
    lower = new Uint32Array(count);
  const seen = new Set<number>();
  let plugs = 0,
    band = 0;
  for (let i = 0; i < count; i++) {
    const at = HEADER + i * 16;
    const r = view.getUint32(at, true),
      k = view.getUint32(at + 4, true),
      u = view.getUint32(at + 8, true),
      l = view.getUint32(at + 12, true);
    if (r >= splatCount) bad('names a splat the character does not have');
    if (seen.has(r)) bad('lists a splat twice');
    seen.add(r);
    if (k !== 1 && k !== 2 && k !== 3)
      bad('has a kind that is not a plug, an inside point or the band');
    if (u >= headVertexCount || l >= headVertexCount)
      bad('names a lip vertex the head does not have');
    row[i] = r;
    kind[i] = k;
    upper[i] = u;
    lower[i] = l;
    if (k === 1) plugs++;
    if (k === 3) band++;
  }
  return { count, plugs, band, up, forward, row, kind, upper, lower };
}

/** The lips' gap the fade runs over, metres: whole below the first, gone from the second. */
export const HIDE_GAP_M: readonly [number, number] = [0.0005, 0.002];
/** A band splat's sizes are capped at this as the lips part there (metres). */
export const BAND_CAP_M = 0.0025;

/**
 * The listed splat's opacity factor for a lips' gap.
 *
 * @param gapM The gap at the splat, metres (the two lip vertices' parting past rest, along up).
 * @returns 1 while the lips touch, 0 from 2 mm apart, a smoothstep between.
 */
export function hiddenAlpha(gapM: number): number {
  const t = Math.min(1, Math.max(0, (gapM - HIDE_GAP_M[0]) / (HIDE_GAP_M[1] - HIDE_GAP_M[0])));
  return 1 - t * t * (3 - 2 * t);
}

/**
 * How far back along the head's forward a plug is pushed for a lips' gap.
 *
 * @param gapM The gap, metres.
 * @returns Metres.
 */
export function plugPush(gapM: number): number {
  const t = Math.min(1, Math.max(0, gapM / 0.002));
  return 0.003 * t * t * (3 - 2 * t) + 0.25 * Math.min(gapM, 0.03);
}

/**
 * Where a listed splat's lanes sit in a packed record (`packGaussianChunk`, 44 floats): the
 * padding lane of each of the binding's three rest-frame rows carries, as an unsigned
 * integer's bits, its kind, its upper and its lower lip vertex; the origin's padding lane a
 * band splat's place in the band shapes (1-based, 0 for none). A splat not listed keeps 0
 * there, which the shader reads as "not listed".
 */
export const HIDDEN_LANE = { kind: 31, upper: 35, lower: 39, band: 43 } as const;

/**
 * Write the lanes for a chunk of the character's own splats.
 *
 * @param records The packed chunk.
 * @param start The chunk's first row in the character.
 * @param count Its rows.
 * @param hidden The list, or null for none (the lanes are then left as packed: 0).
 * @returns Nothing; `records` is written.
 */
export function hiddenLanes(
  records: Float32Array,
  start: number,
  count: number,
  hidden: MouthHidden | null,
): void {
  if (!hidden) return;
  const u = new Uint32Array(records.buffer, records.byteOffset, records.length);
  let bandAt = 0;
  for (let i = 0; i < hidden.count; i++) {
    const band = hidden.kind[i] === 3 ? ++bandAt : 0;
    const n = hidden.row[i] - start;
    if (n < 0 || n >= count) continue;
    u[n * 44 + HIDDEN_LANE.kind] = hidden.kind[i];
    u[n * 44 + HIDDEN_LANE.upper] = hidden.upper[i];
    u[n * 44 + HIDDEN_LANE.lower] = hidden.lower[i];
    u[n * 44 + HIDDEN_LANE.band] = band;
  }
}

/**
 * The band splats' own shapes, in the order the list has them: per band splat its turn as
 * a unit quaternion (w x y z) and its three sizes (metres, the PLY's `exp(scale)`), which
 * the shader caps and rebuilds the covariance from. Two vec4 per band splat; one row of
 * zeros when the list has no band, so the buffer is never empty.
 *
 * @param hidden The list.
 * @param rotation Reads a splat row's quaternion (w x y z) into `out`.
 * @param sizes Reads a splat row's three sizes into `out`.
 * @returns The floats, 8 per band splat.
 */
export function bandShapes(
  hidden: MouthHidden,
  rotation: (row: number, out: Float32Array) => void,
  sizes: (row: number, out: Float32Array) => void,
): Float32Array {
  const out = new Float32Array(Math.max(1, hidden.band) * 8);
  const q = new Float32Array(4),
    sz = new Float32Array(3);
  let at = 0;
  for (let i = 0; i < hidden.count; i++) {
    if (hidden.kind[i] !== 3) continue;
    rotation(hidden.row[i], q);
    const len = Math.hypot(q[0], q[1], q[2], q[3]) || 1;
    for (let k = 0; k < 4; k++) out[at * 8 + k] = q[k] / len;
    sizes(hidden.row[i], sz);
    for (let k = 0; k < 3; k++) out[at * 8 + 4 + k] = sz[k];
    at++;
  }
  return out;
}
