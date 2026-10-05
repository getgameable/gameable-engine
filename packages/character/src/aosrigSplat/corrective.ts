/**
 * Pose corrections, as data: a package's `corrective/` folder (the characters concept page,
 * "Pose corrections"). A correction is made for one pose the character's skin tears at
 * (Tala: both arms raised 90 degrees, the armpits and the jacket's sides) and blends in as
 * the pose approaches. Per side, the upper arm's elevation from hanging drives a weight;
 * each of the character's own splats fades toward its keep factor by that weight, and the
 * correction's own new splats (the surface no camera saw) show by it. At weight 0 nothing
 * changes: the frame is the one a package without the folder draws.
 *
 * No GPU here: the index, the two per-splat files and the weight curve, all testable in node.
 * `runtime.ts` packs the lanes and reads the arms each frame; `boundSplatNode.ts` applies them.
 */
import { halfToFloat } from '../rig/gnm/gnmPack.js';

/** The five files a correction names, relative to `corrective/`. */
export const CORRECTIVE_FILES = [
  'fade.bin',
  'side.bin',
  'points.ply',
  'points_bindings.bin',
  'points_side.bin',
] as const;
export type CorrectiveFileName = (typeof CORRECTIVE_FILES)[number];

/**
 * How many corrections the GPU plays: two weight slots per correction (its left and right),
 * four slots in all. A package listing more is played from the first ones, with a warning.
 */
export const MAX_CORRECTIONS_PLAYED = 2;

/** One side's drive: which arm, read in which joint's frame, and the angles the blend runs between. */
export interface CorrectiveDrive {
  /** 0 the character's left, 1 its right. */
  side: 0 | 1;
  /** The upper arm's joint and the joint after it (its direction is the arm's). */
  bone: [string, string];
  /** The joint whose rest orientation the arm's elevation is read in (a lean of the torso does not count). */
  frame: string;
  /** The arm's elevation at rest, degrees from hanging straight down. */
  restDeg: number;
  /** The weight leaves 0 here... */
  fromDeg: number;
  /** ...and reaches 1 here (and stays 1 past it). */
  toDeg: number;
  curve: 'smoothstep';
}

/** One correction, as `corrective/index.json` lists it. */
export interface CorrectiveInfo {
  name: string;
  label: string;
  /** The pose it was made at, degrees, when the index says. */
  trainedDeg: number | null;
  drives: CorrectiveDrive[];
  /** The character's splat count it was made for (must be the package's). */
  splatCount: number;
  /** Its own new splats. */
  points: number;
  /** Paths relative to `corrective/`. */
  files: Record<CorrectiveFileName, string>;
  /** Hashes, when the index carries them. */
  sha256: Partial<Record<CorrectiveFileName, string>>;
}

const NAME = /^[a-zA-Z0-9_-]{1,64}$/;
/** A path under `corrective/`: folders and a file name, never absolute, never climbing. */
const RELATIVE = /^(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_-]+\.[a-z0-9]+$/;
const HEX64 = /^[a-f0-9]{64}$/;
const finite = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);

/**
 * Validate `corrective/index.json` against the package it rides with.
 *
 * @param value Parsed JSON.
 * @param descriptor The package's splat count and joint names.
 * @returns The corrections, in the index's order.
 * @throws {Error} When the format is not this one, a correction was made for another
 *   character (splat count), a drive names a joint the rig lacks, its angles are not in
 *   order, or a path is not a plain path under `corrective/`.
 */
export function parseCorrectiveIndex(
  value: unknown,
  descriptor: { splatCount: number; jointNames: readonly string[] },
): CorrectiveInfo[] {
  const bad = (what: string): never => {
    throw new Error(`aosrig-splat: corrective/index.json ${what}`);
  };
  const obj = (x: unknown): Record<string, unknown> | null =>
    x && typeof x === 'object' && !Array.isArray(x) ? (x as Record<string, unknown>) : null;
  const root = obj(value);
  if (!root || root.format !== 'aosrig-splat-corrective' || root.version !== 1)
    return bad('is not a pose correction index');
  const list = root.corrections;
  if (!Array.isArray(list) || list.length < 1 || list.length > 8)
    return bad('lists no corrections');
  const names = new Set<string>();
  const out: CorrectiveInfo[] = [];
  for (const raw of list as unknown[]) {
    const c = obj(raw);
    if (!c) return bad('has a correction that is not an object');
    const name = typeof c.name === 'string' ? c.name : '';
    if (!NAME.test(name) || names.has(name))
      return bad('has a correction without a plain, unique name');
    names.add(name);
    if (c.splatCount !== descriptor.splatCount)
      return bad(`has "${name}" made for another character (splat count)`);
    const points = typeof c.points === 'number' ? c.points : -1;
    if (!Number.isSafeInteger(points) || points < 0 || points > 1_000_000)
      return bad(`has "${name}" with a bad point count`);
    const rawDrives = c.drives;
    if (!Array.isArray(rawDrives) || rawDrives.length < 1 || rawDrives.length > 2)
      return bad(`has "${name}" without one drive per side`);
    const sides = new Set<number>();
    const drives: CorrectiveDrive[] = [];
    for (const rawDrive of rawDrives as unknown[]) {
      const d = obj(rawDrive);
      if (!d) return bad(`has "${name}" with a drive that is not an object`);
      const side: 0 | 1 | -1 = d.side === 0 ? 0 : d.side === 1 ? 1 : -1;
      if (side === -1 || sides.has(side))
        return bad(`has "${name}" with a drive on no side or a side twice`);
      sides.add(side);
      const bone = Array.isArray(d.bone) ? (d.bone as unknown[]) : [];
      const [upper, lower] = bone;
      if (
        bone.length !== 2 ||
        typeof upper !== 'string' ||
        typeof lower !== 'string' ||
        upper === lower ||
        !descriptor.jointNames.includes(upper) ||
        !descriptor.jointNames.includes(lower)
      )
        return bad(`has "${name}" driven by joints the rig does not have`);
      const frame = typeof d.frame === 'string' ? d.frame : '';
      if (!descriptor.jointNames.includes(frame))
        return bad(`has "${name}" read in a frame joint the rig does not have`);
      const restDeg = finite(d.restDeg) ? d.restDeg : Number.NaN;
      const fromDeg = finite(d.fromDeg) ? d.fromDeg : Number.NaN;
      const toDeg = finite(d.toDeg) ? d.toDeg : Number.NaN;
      if (!(restDeg >= 0 && fromDeg >= restDeg && toDeg > fromDeg && toDeg <= 180))
        return bad(`has "${name}" with angles out of order (rest <= from < to <= 180)`);
      if (d.curve !== 'smoothstep')
        return bad(`has "${name}" with a curve the engine does not know`);
      drives.push({
        side,
        bone: [upper, lower],
        frame,
        restDeg,
        fromDeg,
        toDeg,
        curve: 'smoothstep',
      });
    }
    const files = obj(c.files);
    if (!files) return bad(`has "${name}" without its files`);
    const paths = {} as Record<CorrectiveFileName, string>;
    for (const file of CORRECTIVE_FILES) {
      const path = files[file];
      if (typeof path !== 'string' || !RELATIVE.test(path))
        return bad(`has "${name}" with a bad path for ${file}`);
      paths[file] = path;
    }
    const sha256: Partial<Record<CorrectiveFileName, string>> = {};
    if (c.sha256 !== undefined) {
      const hashes = obj(c.sha256);
      if (!hashes) return bad(`has "${name}" with bad hashes`);
      for (const file of CORRECTIVE_FILES) {
        const hex = hashes[file];
        if (hex === undefined) continue;
        if (typeof hex !== 'string' || !HEX64.test(hex))
          return bad(`has "${name}" with a bad hash for ${file}`);
        sha256[file] = hex;
      }
    }
    out.push({
      name,
      label: typeof c.label === 'string' ? c.label : name,
      trainedDeg: finite(c.trainedDeg) ? c.trainedDeg : null,
      drives,
      splatCount: descriptor.splatCount,
      points,
      files: paths,
      sha256,
    });
  }
  return out;
}

/**
 * `fade.bin`: each of the character's splats' opacity factor at full blend, 1 = untouched.
 *
 * @param bytes The file (float16, little-endian, in `character.ply`'s row order).
 * @param count The character's splat count.
 * @returns The factors, 0..1.
 * @throws {Error} On the wrong size or a value outside 0..1.
 */
export function parseFade(bytes: Uint8Array, count: number): Float32Array {
  if (bytes.length !== count * 2) throw new Error('aosrig-splat: fade.bin has the wrong size');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    const f = halfToFloat(view.getUint16(i * 2, true));
    if (!(f >= 0 && f <= 1)) throw new Error('aosrig-splat: fade.bin has a factor outside 0..1');
    out[i] = f;
  }
  return out;
}

/**
 * `side.bin` / `points_side.bin`: which side's weight each splat takes.
 *
 * @param bytes The file (one byte per splat).
 * @param count The splats.
 * @returns 0 (left) or 1 (right) per splat.
 * @throws {Error} On the wrong size or a byte that is neither.
 */
export function parseSide(bytes: Uint8Array, count: number): Uint8Array {
  if (bytes.length !== count) throw new Error('aosrig-splat: a side file has the wrong size');
  for (let i = 0; i < count; i++)
    if (bytes[i] > 1) throw new Error('aosrig-splat: a side file names a side that is not 0 or 1');
  return bytes.slice();
}

/**
 * How many of a correction's splats fade at all (a keep factor under 1).
 *
 * @param fade From {@link parseFade}.
 * @returns The count.
 */
export function fadedCount(fade: Float32Array): number {
  let n = 0;
  for (const f of fade) if (f < 1) n++;
  return n;
}

/**
 * The new splats the GPU is given room for: those of the corrections it plays.
 *
 * @param corrections The package's corrections, in the index's order (or none).
 * @returns Their point counts summed, over the first {@link MAX_CORRECTIONS_PLAYED}.
 */
export function correctivePoints(
  corrections: readonly { info: { points: number } }[] | undefined,
): number {
  let n = 0;
  for (const c of (corrections ?? []).slice(0, MAX_CORRECTIONS_PLAYED)) n += c.info.points;
  return n;
}

/**
 * A drive's weight for an arm elevation: 0 up to `fromDeg`, a smoothstep to `toDeg`, 1 from
 * there on.
 *
 * @param thetaDeg The arm's elevation from hanging, degrees.
 * @param drive The drive.
 * @returns The weight, 0..1.
 */
export function blendWeight(
  thetaDeg: number,
  drive: Pick<CorrectiveDrive, 'fromDeg' | 'toDeg'>,
): number {
  const t = Math.min(
    1,
    Math.max(0, (thetaDeg - drive.fromDeg) / Math.max(1e-6, drive.toDeg - drive.fromDeg)),
  );
  return t * t * (3 - 2 * t);
}

/**
 * The arm's elevation from hanging straight down, read in the frame joint's rest
 * orientation: `d' = R_rest · R_now⁻¹ · d`, so a lean of the whole torso does not count.
 * `frame` is the joint's turn since rest (its skin matrix in the character's frame,
 * `R_now · R_rest⁻¹`), so `d'` is its transpose applied to `d`.
 *
 * @param dx The arm's direction: the joint after the upper arm less the upper arm, x.
 * @param dy Its y (the character's up is +y).
 * @param dz Its z.
 * @param frame The frame joint's skin matrix, column-major 4x4.
 * @returns Degrees: 0 hanging, 90 straight out (in any direction), 180 straight up.
 */
export function armAngleDeg(dx: number, dy: number, dz: number, frame: ArrayLike<number>): number {
  const len = Math.hypot(dx, dy, dz);
  if (len < 1e-9) return 0;
  // the second column of the turn is where the frame's own up went; its dot with d is d'.y
  const ux = frame[4],
    uy = frame[5],
    uz = frame[6];
  const ul = Math.hypot(ux, uy, uz) || 1;
  const c = -(ux * dx + uy * dy + uz * dz) / (len * ul);
  return (Math.acos(Math.min(1, Math.max(-1, c))) * 180) / Math.PI;
}

/**
 * Where a splat's correction lanes sit in a packed record (`packGaussianChunk`, 44 floats):
 * its keep factor in `center.w`, its weight slot (correction x 2 + side) in `covB.z`, its kind
 * (0 one of the character's own, 1 a correction's new splat) in `covB.w`. A record without
 * a correction holds 1, 0, 0 there, which the shader reads as "unchanged".
 */
export const LANE = { fade: 3, slot: 10, kind: 11 } as const;

/**
 * Write the character's own splats' lanes: each keeps the strongest fade any played
 * correction gives it, with that correction's slot.
 *
 * @param records The packed chunk.
 * @param start The chunk's first row in the character.
 * @param count Its rows.
 * @param corrections The played corrections' fade and side per character row.
 * @returns Nothing; `records` is written.
 */
export function ownLanes(
  records: Float32Array,
  start: number,
  count: number,
  corrections: readonly { fade: Float32Array; side: Uint8Array }[],
): void {
  const played = Math.min(corrections.length, MAX_CORRECTIONS_PLAYED);
  for (let n = 0; n < count; n++) {
    const i = start + n,
      o = n * 44;
    let keep = 1,
      slot = 0;
    for (let c = 0; c < played; c++) {
      const f = corrections[c].fade[i];
      if (f < keep) {
        keep = f;
        slot = c * 2 + corrections[c].side[i];
      }
    }
    records[o + LANE.fade] = keep;
    records[o + LANE.slot] = slot;
    records[o + LANE.kind] = 0;
  }
}

/**
 * Write a correction's new splats' lanes: shown by their side's weight.
 *
 * @param records The packed chunk of new splats.
 * @param count Its rows.
 * @param correction The correction's index among those played.
 * @param side Per row, from `points_side.bin` (from the chunk's first row).
 * @returns Nothing; `records` is written.
 */
export function newLanes(
  records: Float32Array,
  count: number,
  correction: number,
  side: Uint8Array,
): void {
  for (let n = 0; n < count; n++) {
    const o = n * 44;
    records[o + LANE.fade] = 1;
    records[o + LANE.slot] = correction * 2 + side[n];
    records[o + LANE.kind] = 1;
  }
}
