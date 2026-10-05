/**
 * The inside of an exported character's mouth, as data: its teeth, gums, tongue and mouth
 * bag (the head pack's `mouth` blobs) and the teeth's own points (`teeth.ply` / `teeth.bin`
 * / `teeth.json`, beside the package's five files). No GPU and no renderer here —
 * `mouthRuntime.ts` draws it — so everything below runs in node and is tested there.
 *
 * WHY A WINDOW. A splat's lips and cheeks are not a skin: the points that make them are a
 * cloud about 3 cm deep inside the head. A mesh drawn inside the head and depth-tested
 * against those points cuts holes in the cheeks and lips wherever it stands in front of
 * their deeper points. So the inside is seen only through the opening between the lips,
 * as through a window.
 *
 * THE WINDOW FOLLOWS THE LIPS' OWN POINTS, not the head model's rim. A character's splat
 * lips need not open as far as the head model's: on Tala the top few millimetres of the
 * lower lip's points are bound to the upper lip and rise with it, so a window from the
 * model's rim cut into the lower lip. So the lips are told apart by how their points MOVE
 * (a jaw probe, `buildLipEdges`), and each lip's edge — its points nearest the lip line at
 * rest — moves the window's side on that lip, frame by frame (`lipEdgePoints`).
 *
 * THE WINDOW IS SOFT: a feathered mask (about 10 px at a 1024 view) fades the inside in
 * from the lips' edge, and the face's own points behind the lips' line fade out by the
 * same mask, so there is no line where the inside meets the lips. It shows only once the
 * lips' points are clearly apart (2 to 3.5 mm in the middle, faded between).
 */
import type { AosRigMouth, AosRigMouthGroup, AosRigPack } from '../rig/gnm/gnmPack.js';
import { halfToFloat } from '../rig/gnm/gnmPack.js';

/** How far back along the camera's rays the window's depth is pushed (metres). */
export const WINDOW_PUSH_M = 0.0015;
/** The face's points fade in over this depth behind the lips' line, not at a step (metres). */
export const WALL_SOFT_M = 0.003;
/** How much of the rim's width the window keeps. */
export const WINDOW_SIDE = 0.82;
/**
 * The inside starts to show once the lips' points are this far apart in the middle (metres),
 * and shows fully from `OPEN_FULL_M`. Measured on Tala's speech in the game (2026-09-25, the
 * recorded intro and live lines, 3,428 speaking frames): the lips' points part 2.3 mm at the
 * 25th percentile, 3.4 mm at the median, 5.3 mm at the 75th; so the inside starts at 2 mm
 * (four frames in five) and is whole from 3.5 mm (the wider half). A page may tune a
 * character's own (`AosrigMouth.thresholds`).
 */
export const OPEN_START_M = 0.002;
/** And shows fully from this far apart. */
export const OPEN_FULL_M = 0.0035;
/** The soft rim's width, as a fraction of the view's height (10 px at a 1024 view). */
export const FEATHER_OF_VIEW = 10 / 1024;
/** A lip's edge: its points within this of the lip's point nearest the lip line, at rest (metres). */
export const EDGE_BAND_M = 0.002;
/** A station of the window takes its lip's edge points this far either side of it across the mouth. */
export const STATION_REACH_M = 0.0025;
/** A point moves with the jaw (lower lip) when the jaw probe takes it at least this far of the lower teeth. */
export const JAW_FOLLOW = 0.5;
/** Light reaching the inside falls to its floor this far behind the lips (metres). */
export const SHADE_DEPTH_M = 0.04;
/** The floor: the back of the bag is this much lit. */
export const SHADE_MIN = 0.08;

/** `teeth.json`: what the teeth's two other files are called. */
export interface TeethInfo {
  /** Points in `teeth.ply`. */
  points: number;
  /** The splat's file name, beside `character.json`. */
  ply: string;
  /** The binding's file name. */
  binding: string;
}

const FILE_NAME = /^[a-zA-Z0-9_-]+\.[a-z0-9]+$/;

/**
 * Validate `teeth.json`.
 *
 * @param value Parsed JSON.
 * @returns The two file names and the point count.
 * @throws {Error} When a field is missing or a name is not a plain sibling file name.
 */
export function parseTeethInfo(value: unknown): TeethInfo {
  const v = value as Partial<Record<keyof TeethInfo, unknown>> | null;
  if (
    !v ||
    typeof v !== 'object' ||
    typeof v.points !== 'number' ||
    !Number.isSafeInteger(v.points) ||
    v.points < 1 ||
    v.points > 1_000_000 ||
    typeof v.ply !== 'string' ||
    !FILE_NAME.test(v.ply) ||
    typeof v.binding !== 'string' ||
    !FILE_NAME.test(v.binding)
  )
    throw new Error('aosrig-splat: invalid teeth.json');
  return { points: v.points, ply: v.ply, binding: v.binding };
}

/** The teeth's files, as the package carries them. */
export interface AosrigTeethFiles {
  info: TeethInfo;
  ply: Uint8Array;
  binding: Uint8Array;
}

/** `teeth.bin`: how each of the teeth's points rides a triangle of the head pack. */
export interface TeethBinding {
  count: number;
  /** How far the studio set the mouth back to meet the splat's lips, character frame (metres). */
  setBack: [number, number, number];
  /** Three head-pack vertex ids per point. */
  tri: Uint32Array;
  /** Where on that triangle, three weights per point (they sum to 1). */
  bary: Float32Array;
  /** How far off the triangle along its unit normal, one per point (metres). */
  height: Float32Array;
}

const TEETH_MAGIC = 'AOSTTH01';

/**
 * Parse `teeth.bin` (`AOSTTH01`, u32 count, 3 f32 set-back, then per point three u32 head
 * vertex ids, three f32 weights and one f32 height, each array whole in turn).
 *
 * @param bytes The file.
 * @param headVertexCount The head pack's vertex count.
 * @returns The binding, copied out of `bytes`.
 * @throws {Error} On a bad magic or size, or a vertex, weight or height out of range.
 */
export function parseTeethBinding(bytes: Uint8Array, headVertexCount: number): TeethBinding {
  const bad = (what: string): never => {
    throw new Error(`aosrig-splat: teeth.bin ${what}`);
  };
  if (bytes.length < 24 || new TextDecoder().decode(bytes.subarray(0, 8)) !== TEETH_MAGIC)
    bad('is not a teeth binding');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = view.getUint32(8, true);
  if (count < 1 || count > 1_000_000 || bytes.length !== 24 + count * 28) bad('has the wrong size');
  const setBack: [number, number, number] = [
    view.getFloat32(12, true),
    view.getFloat32(16, true),
    view.getFloat32(20, true),
  ];
  if (!setBack.every((x) => Number.isFinite(x) && Math.abs(x) < 0.05))
    bad('set-back is out of range');
  const data = bytes.slice(24);
  const tri = new Uint32Array(data.buffer, 0, count * 3);
  const bary = new Float32Array(data.buffer, count * 12, count * 3);
  const height = new Float32Array(data.buffer, count * 24, count);
  for (let i = 0; i < count; i++) {
    let sum = 0;
    for (let k = 0; k < 3; k++) {
      if (tri[i * 3 + k] >= headVertexCount) bad('names a vertex the head does not have');
      const w = bary[i * 3 + k];
      if (!Number.isFinite(w) || w < -1e-3 || w > 1 + 1e-3) bad('has a weight out of range');
      sum += w;
    }
    if (Math.abs(sum - 1) > 1e-3) bad('has weights that do not sum to 1');
    if (!Number.isFinite(height[i]) || Math.abs(height[i]) > 0.05) bad('has a height out of range');
  }
  return { count, setBack, tri, bary, height };
}

/** The mouth as one mesh, part by part, with what the GPU and the window need. */
export interface MouthMesh {
  /** The head pack's vertex id of each mesh vertex, part by part (a vertex two parts share is in both). */
  ids: Uint32Array;
  /** Each mesh vertex's part, an index into `groups`. */
  part: Uint8Array;
  /** Triangles as mesh-vertex indices, part by part. */
  tris: Uint32Array;
  /** `groups.length + 1` offsets into `tris`, in triangles: part k is `[start[k], start[k+1])`. */
  partStart: Uint32Array;
  /** Per mesh vertex, where its triangles start in `adjTris` (length `ids.length + 1`). */
  adjStart: Uint32Array;
  /** The triangles each vertex's normal is summed over, three head-pack vertex ids each. */
  adjTris: Uint32Array;
  /** The lips' inner rim: head-pack vertex ids of the bag's open end, in order round it. */
  rim: Uint32Array;
  /** The parts, as the pack names and colours them. */
  groups: AosRigMouthGroup[];
  /** The index of the bag among `groups`. */
  bag: number;
}

/** The names a bake gives the mouth's bag. */
const BAG_NAMES = ['mouth_sock', 'bag', 'mouth_bag', 'mouthBag'];

/**
 * The open end of a bag of triangles: its boundary edges walked round, in order.
 *
 * @param faces (T,3) vertex ids.
 * @param member Which vertices belong to the bag.
 * @returns The loop's vertex ids.
 * @throws {Error} When the boundary is not exactly one loop.
 */
export function rimLoop(faces: Uint32Array, member: (v: number) => boolean): Uint32Array {
  const count = new Map<string, number>();
  for (let t = 0; t < faces.length; t += 3) {
    const a = faces[t],
      b = faces[t + 1],
      c = faces[t + 2];
    if (!member(a) || !member(b) || !member(c)) continue;
    for (const [x, y] of [
      [a, b],
      [b, c],
      [c, a],
    ]) {
      const key = x < y ? `${String(x)},${String(y)}` : `${String(y)},${String(x)}`;
      count.set(key, (count.get(key) ?? 0) + 1);
    }
  }
  const adj = new Map<number, number[]>();
  for (const [key, n] of count) {
    if (n !== 1) continue;
    const [x, y] = key.split(',').map(Number);
    adj.set(x, [...(adj.get(x) ?? []), y]);
    adj.set(y, [...(adj.get(y) ?? []), x]);
  }
  if (adj.size < 3 || [...adj.values()].some((v) => v.length !== 2))
    throw new Error("aosrig-splat: the mouth bag's open end is not one loop");
  const start = Math.min(...adj.keys());
  const loop = [start];
  let prev = start,
    cur = (adj.get(start) ?? [])[0];
  while (cur !== start) {
    loop.push(cur);
    const [x, y] = adj.get(cur) ?? [];
    const next = x !== prev ? x : y;
    prev = cur;
    cur = next;
    if (loop.length > adj.size) break;
  }
  if (loop.length !== adj.size)
    throw new Error("aosrig-splat: the mouth bag's open end is more than one loop");
  return Uint32Array.from(loop);
}

/**
 * The pack's mouth as one mesh with a vertex list per part, each vertex's triangles for its
 * normal, and the rim of the bag.
 *
 * @param mouth The pack's parsed mouth.
 * @returns The mesh.
 * @throws {Error} When the bag has no single open end.
 */
export function buildMouthMesh(mouth: AosRigMouth): MouthMesh {
  const { groups, faces, faceParts } = mouth;
  let bag = groups.findIndex((g) => BAG_NAMES.includes(g.name));
  if (bag < 0) bag = groups.length - 1;
  const bagSet = new Set(groups[bag].vertices);
  const rim = rimLoop(faces, (v) => bagSet.has(v));
  const ids: number[] = [];
  const part: number[] = [];
  const tris: number[] = [];
  const partStart = new Uint32Array(groups.length + 1);
  const adjacency: number[][] = [];
  for (let k = 0; k < groups.length; k++) {
    partStart[k] = tris.length / 3;
    const local = new Map<number, number>();
    for (let t = 0; t < faceParts.length; t++) {
      if (faceParts[t] !== k + 1) continue;
      for (let c = 0; c < 3; c++) {
        const v = faces[t * 3 + c];
        let i = local.get(v);
        if (i === undefined) {
          i = ids.length;
          local.set(v, i);
          ids.push(v);
          part.push(k);
          adjacency.push([]);
        }
        tris.push(i);
        adjacency[i].push(t);
      }
    }
  }
  partStart[groups.length] = tris.length / 3;
  const adjStart = new Uint32Array(ids.length + 1);
  const adjTris: number[] = [];
  for (let i = 0; i < ids.length; i++) {
    adjStart[i] = adjTris.length / 3;
    for (const t of adjacency[i]) adjTris.push(faces[t * 3], faces[t * 3 + 1], faces[t * 3 + 2]);
  }
  adjStart[ids.length] = adjTris.length / 3;
  return {
    ids: Uint32Array.from(ids),
    part: Uint8Array.from(part),
    tris: Uint32Array.from(tris),
    partStart,
    adjStart,
    adjTris: Uint32Array.from(adjTris),
    rim,
    groups,
    bag,
  };
}

/**
 * The pack's vertices at rest in the character frame: `bindTransform · (neutral + seam)`,
 * which is what the head's vertex buffer holds at zero expression.
 *
 * @param pack The head pack.
 * @returns x y z per vertex.
 */
export function restVertices(pack: AosRigPack): Float64Array {
  const m = pack.bindTransform;
  const out = new Float64Array(pack.neutral.length);
  for (let i = 0; i < pack.neutral.length; i += 3) {
    const x = pack.neutral[i] + (pack.stitchLocal?.[i] ?? 0);
    const y = pack.neutral[i + 1] + (pack.stitchLocal?.[i + 1] ?? 0);
    const z = pack.neutral[i + 2] + (pack.stitchLocal?.[i + 2] ?? 0);
    out[i] = m[0] * x + m[1] * y + m[2] * z + m[3];
    out[i + 1] = m[4] * x + m[5] * y + m[6] * z + m[7];
    out[i + 2] = m[8] * x + m[9] * y + m[10] * z + m[11];
  }
  return out;
}

/**
 * Where a teeth point's binding puts it on a set of vertices: the blend of its triangle's
 * corners plus its height along the triangle's unit normal.
 *
 * @param b The binding.
 * @param i The point.
 * @param verts x y z per head vertex.
 * @param out Three numbers, written.
 * @returns `out`.
 */
export function teethPoint(
  b: TeethBinding,
  i: number,
  verts: ArrayLike<number>,
  out: [number, number, number],
): [number, number, number] {
  const i0 = b.tri[i * 3] * 3,
    i1 = b.tri[i * 3 + 1] * 3,
    i2 = b.tri[i * 3 + 2] * 3;
  const ax = verts[i1] - verts[i0],
    ay = verts[i1 + 1] - verts[i0 + 1],
    az = verts[i1 + 2] - verts[i0 + 2];
  const bx = verts[i2] - verts[i0],
    by = verts[i2 + 1] - verts[i0 + 1],
    bz = verts[i2 + 2] - verts[i0 + 2];
  let nx = ay * bz - az * by,
    ny = az * bx - ax * bz,
    nz = ax * by - ay * bx;
  const len = Math.hypot(nx, ny, nz) || 1;
  nx /= len;
  ny /= len;
  nz /= len;
  const w0 = b.bary[i * 3],
    w1 = b.bary[i * 3 + 1],
    w2 = b.bary[i * 3 + 2],
    h = b.height[i];
  out[0] = w0 * verts[i0] + w1 * verts[i1] + w2 * verts[i2] + h * nx;
  out[1] = w0 * verts[i0 + 1] + w1 * verts[i1 + 1] + w2 * verts[i2 + 1] + h * ny;
  out[2] = w0 * verts[i0 + 2] + w1 * verts[i1 + 2] + w2 * verts[i2 + 2] + h * nz;
  return out;
}

/**
 * Each point's own centre less where its binding puts it on the head at rest.
 *
 * The studio fitted the points on its own registration of the head, which stands within a
 * millimetre or two of the head pack's (Tala: 0.9 mm median, 2.3 mm at most). Keeping this
 * offset puts every point exactly where its file has it at rest, and moves it with its
 * triangle from there — which is what the studio does. `teeth.ply` is in the character
 * frame; a file in the PLY's own frame (off by `plyToCharacter`) is accepted too.
 *
 * @param centres x y z per point, from `teeth.ply`.
 * @param b The binding.
 * @param rest The head pack at rest, x y z per vertex (`restVertices`).
 * @param plyShift `plyToCharacter`'s translation.
 * @returns The offsets (x y z per point) and their mean.
 * @throws {Error} When the points do not sit on their binding in either frame (more than
 *   2 cm off on average): the files are for another character.
 */
export function teethOffsets(
  centres: Float32Array,
  b: TeethBinding,
  rest: Float64Array,
  plyShift: [number, number, number],
): { offsets: Float32Array; mean: [number, number, number] } {
  const n = b.count;
  const bound = new Float64Array(n * 3);
  const p: [number, number, number] = [0, 0, 0];
  for (let i = 0; i < n; i++) bound.set(teethPoint(b, i, rest, p), i * 3);
  const meanOf = (shift: [number, number, number]): [number, number, number] => {
    const m: [number, number, number] = [0, 0, 0];
    for (let i = 0; i < n; i++)
      for (let c = 0; c < 3; c++) m[c] += centres[i * 3 + c] + shift[c] - bound[i * 3 + c];
    return [m[0] / n, m[1] / n, m[2] / n];
  };
  const plain = meanOf([0, 0, 0]);
  const shifted = meanOf(plyShift);
  const useShift = Math.hypot(...shifted) < Math.hypot(...plain);
  const shift = useShift ? plyShift : ([0, 0, 0] as [number, number, number]);
  const mean = useShift ? shifted : plain;
  if (Math.hypot(...mean) > 0.02)
    throw new Error('aosrig-splat: the teeth do not sit on this head (teeth.bin is for another)');
  const offsets = new Float32Array(n * 3);
  for (let i = 0; i < n * 3; i++) offsets[i] = centres[i] + shift[i % 3] - bound[i];
  return { offsets, mean };
}

/**
 * The head pack's expression evaluated on the CPU for a few vertices (the lips' edge points'
 * triangles), in the character frame — exactly what the GPU's blend writes for them. The fp16
 * basis rows are widened once, and a coefficient that moves none of these vertices is left out
 * (the eyes' 200 never move the lips).
 *
 * @param pack The head pack.
 * @param ids The vertices.
 * @returns `evaluate(expression, out)`: `expression` is the head's control vector (only its
 *   expression half is read), `out` x y z per vertex; and `coefficients`, how many it reads.
 */
export function createVertexExpression(
  pack: AosRigPack,
  ids: Uint32Array,
): { coefficients: number; evaluate(expression: ArrayLike<number>, out: Float32Array): void } {
  const E = pack.coeffCount,
    n = ids.length;
  const full = new Float32Array(n * E * 3);
  const base = new Float64Array(n * 3);
  const used = new Uint8Array(E);
  for (let k = 0; k < n; k++) {
    const v = ids[k];
    for (let c = 0; c < 3; c++)
      base[k * 3 + c] = pack.neutral[v * 3 + c] + (pack.stitchLocal?.[v * 3 + c] ?? 0);
    for (let e = 0; e < E; e++)
      for (let c = 0; c < 3; c++) {
        const lane = (v * E + e) * 3 + c;
        const half = (pack.basis[lane >> 1] >>> ((lane & 1) * 16)) & 0xffff;
        const value = halfToFloat(half) * pack.basisScale[e];
        full[(k * E + e) * 3 + c] = value;
        if (value !== 0) used[e] = 1;
      }
  }
  const active: number[] = [];
  for (let e = 0; e < E; e++) if (used[e] === 1) active.push(e);
  const A = active.length;
  const basis = new Float32Array(n * A * 3);
  for (let k = 0; k < n; k++)
    for (let a = 0; a < A; a++)
      for (let c = 0; c < 3; c++) basis[(k * A + a) * 3 + c] = full[(k * E + active[a]) * 3 + c];
  const m = pack.bindTransform;
  const w = new Float64Array(A);
  return {
    coefficients: A,
    evaluate(expression, out) {
      for (let a = 0; a < A; a++) {
        const e = active[a];
        w[a] = e < expression.length ? expression[e] : 0;
      }
      for (let k = 0; k < n; k++) {
        let x = base[k * 3],
          y = base[k * 3 + 1],
          z = base[k * 3 + 2];
        const row = k * A * 3;
        for (let a = 0; a < A; a++) {
          const wa = w[a];
          if (wa === 0) continue;
          const o = row + a * 3;
          x += wa * basis[o];
          y += wa * basis[o + 1];
          z += wa * basis[o + 2];
        }
        out[k * 3] = m[0] * x + m[1] * y + m[2] * z + m[3];
        out[k * 3 + 1] = m[4] * x + m[5] * y + m[6] * z + m[7];
        out[k * 3 + 2] = m[8] * x + m[9] * y + m[10] * z + m[11];
      }
    },
  };
}

/** Enough of `bindings.bin` and `character.ply` to find and move the lips' own points. */
export interface FaceSplats {
  count: number;
  /** Rest centre of splat `i`, the character frame, into `out`. */
  position(i: number, out: [number, number, number]): void;
  /** Its opacity, 0..1. */
  opacity(i: number): number;
  /** The 28 binding lanes per splat (`parseBindings`). */
  bindings: Float32Array;
}

/** Bound face points as the bound-splat shader reads them, with their own vertex list. */
export interface BoundPoints {
  /** Rest centres, x y z. */
  rest: Float64Array;
  /** Per point, its triangle's three vertices as indices into `verts`. */
  tri: Uint32Array;
  /** How much each follows its triangle. */
  blend: Float32Array;
  /** The inverse rest frame's rows (9 per point). */
  inv: Float32Array;
  /** The rest position of the triangle's first vertex (3 per point). */
  origin: Float32Array;
  /** The head vertices the points ride. */
  verts: Uint32Array;
}

/** A lip's edge points and how they move the window, built once per character. */
export interface LipEdges extends BoundPoints {
  /** The face's frame at the mouth: across (corner to corner), up (toward the nose), forward. */
  across: [number, number, number];
  up: [number, number, number];
  forward: [number, number, number];
  /** Per rim station: 0 upper lip, 1 lower lip, 2 a corner. */
  lip: Uint8Array;
  /** Per station, where its window point is at rest (the two lips' edges' midline), x y z. */
  base: Float64Array;
  /** Station membership: pairs of (edge point, station) with a weight (its opacity). */
  pairPoint: Uint32Array;
  pairStation: Uint16Array;
  pairWeight: Float32Array;
  /** Per station without points of its own, the station it borrows from (itself otherwise). */
  borrow: Uint16Array;
  /** The stations in the middle of the mouth, for how far apart the lips are there. */
  middle: Uint8Array;
  /** How many edge points each lip has, and how many candidates were looked at. */
  counts: { upper: number; lower: number; candidates: number };
}

const dot3 = (a: ArrayLike<number>, b: ArrayLike<number>, ao = 0, bo = 0): number =>
  a[ao] * b[bo] + a[ao + 1] * b[bo + 1] + a[ao + 2] * b[bo + 2];

function unit(x: number, y: number, z: number): [number, number, number] {
  const l = Math.hypot(x, y, z) || 1;
  return [x / l, y / l, z / l];
}

/**
 * Move bound face points to where the expression puts them, exactly as `boundSplatNode.ts`
 * does before the body's skinning: `p' = mix(p, a' + [e1' e2' n'] inv (p - origin), blend)`.
 *
 * @param e The points.
 * @param vpos x y z per entry of `e.verts`, now.
 * @param out x y z per point, written.
 * @returns `out`.
 */
export function moveBoundPoints(
  e: BoundPoints,
  vpos: ArrayLike<number>,
  out: Float64Array,
): Float64Array {
  const n = e.blend.length;
  for (let i = 0; i < n; i++) {
    const px = e.rest[i * 3],
      py = e.rest[i * 3 + 1],
      pz = e.rest[i * 3 + 2];
    const bl = e.blend[i];
    const a = e.tri[i * 3] * 3,
      b = e.tri[i * 3 + 1] * 3,
      c = e.tri[i * 3 + 2] * 3;
    const e1x = vpos[b] - vpos[a],
      e1y = vpos[b + 1] - vpos[a + 1],
      e1z = vpos[b + 2] - vpos[a + 2];
    const e2x = vpos[c] - vpos[a],
      e2y = vpos[c + 1] - vpos[a + 1],
      e2z = vpos[c + 2] - vpos[a + 2];
    let nx = e1y * e2z - e1z * e2y,
      ny = e1z * e2x - e1x * e2z,
      nz = e1x * e2y - e1y * e2x;
    const area = Math.hypot(nx, ny, nz);
    if (bl <= 0 || area <= 1e-10) {
      out[i * 3] = px;
      out[i * 3 + 1] = py;
      out[i * 3 + 2] = pz;
      continue;
    }
    nx /= area;
    ny /= area;
    nz /= area;
    const q = i * 9;
    const dx = px - e.origin[i * 3],
      dy = py - e.origin[i * 3 + 1],
      dz = pz - e.origin[i * 3 + 2];
    // the inverse rest frame (rows) times (p - origin): the point in its triangle's frame
    const u = e.inv[q] * dx + e.inv[q + 1] * dy + e.inv[q + 2] * dz;
    const v = e.inv[q + 3] * dx + e.inv[q + 4] * dy + e.inv[q + 5] * dz;
    const w = e.inv[q + 6] * dx + e.inv[q + 7] * dy + e.inv[q + 8] * dz;
    const qx = vpos[a] + e1x * u + e2x * v + nx * w,
      qy = vpos[a + 1] + e1y * u + e2y * v + ny * w,
      qz = vpos[a + 2] + e1z * u + e2z * v + nz * w;
    out[i * 3] = px + (qx - px) * bl;
    out[i * 3 + 1] = py + (qy - py) * bl;
    out[i * 3 + 2] = pz + (qz - pz) * bl;
  }
  return out;
}

/** Copy the binding lanes and rest centres of some face points, with their own vertex list. */
function gather(ids: number[], splats: FaceSplats): BoundPoints {
  const n = ids.length;
  const rest = new Float64Array(n * 3),
    tri = new Uint32Array(n * 3),
    blend = new Float32Array(n),
    inv = new Float32Array(n * 9),
    origin = new Float32Array(n * 3);
  const u = new Uint32Array(
    splats.bindings.buffer,
    splats.bindings.byteOffset,
    splats.bindings.length,
  );
  const vmap = new Map<number, number>();
  const verts: number[] = [];
  const p: [number, number, number] = [0, 0, 0];
  for (let j = 0; j < n; j++) {
    const i = ids[j],
      o = i * 28;
    splats.position(i, p);
    rest.set(p, j * 3);
    for (let c = 0; c < 3; c++) {
      const v = u[o + 8 + c];
      let local = vmap.get(v);
      if (local === undefined) {
        local = verts.length;
        vmap.set(v, local);
        verts.push(v);
      }
      tri[j * 3 + c] = local;
    }
    blend[j] = splats.bindings[o + 11];
    for (let r = 0; r < 3; r++)
      for (let c = 0; c < 3; c++) inv[j * 9 + r * 3 + c] = splats.bindings[o + 12 + r * 4 + c];
    for (let c = 0; c < 3; c++) origin[j * 3 + c] = splats.bindings[o + 24 + c];
  }
  return { rest, tri, blend, inv, origin, verts: Uint32Array.from(verts) };
}

/**
 * The lips' own edge points, and how each station of the window follows them.
 *
 * 1. The jaw probe: the lower teeth are the teeth the expression moves (the upper ones move
 *    with no coefficient); their mean vertical basis row is a direction in expression space
 *    that opens the jaw. What it moves at least `JAW_FOLLOW` as far as the lower teeth is
 *    lower lip, the rest upper lip — for the rim's two halves and for every point.
 * 2. The candidates: the face's bound, opaque points inside the mouth's width, within 12 mm
 *    of the lip line and in a depth band about the lips (12 mm behind the head model's lips
 *    to 4 mm in front).
 * 3. Per rim station, each lip's edge: that lip's candidates within `STATION_REACH_M` across,
 *    the ones within `EDGE_BAND_M` of the lip's point nearest the lip line. The station's
 *    rest point is the rim point moved up or down to the midline between the two edges; its
 *    own lip's edge moves it.
 *
 * @param o The head pack, its mouth mesh, its vertices at rest (`restVertices`) and the face's points.
 * @returns The edges.
 * @throws {Error} When the teeth do not move, or a lip has no edge points.
 */
export function buildLipEdges(o: {
  pack: AosRigPack;
  mesh: MouthMesh;
  rest: Float64Array;
  splats: FaceSplats;
}): LipEdges {
  const { pack, mesh, rest, splats } = o;
  const E = pack.coeffCount;
  const nr = mesh.rim.length;
  const rimRest = new Float64Array(nr * 3);
  for (let k = 0; k < nr; k++)
    for (let c = 0; c < 3; c++) rimRest[k * 3 + c] = rest[mesh.rim[k] * 3 + c];
  const [ca, cb] = windowCorners(rimRest);
  const c0: [number, number, number] = [0, 0, 0];
  for (let k = 0; k < nr; k++) for (let c = 0; c < 3; c++) c0[c] += rimRest[k * 3 + c] / nr;
  // forward: from the bag's middle to the lips; across: corner to corner; up: toward the nose
  const bagC: [number, number, number] = [0, 0, 0];
  let bn = 0;
  for (let t = mesh.partStart[mesh.bag]; t < mesh.partStart[mesh.bag + 1]; t++)
    for (let c = 0; c < 3; c++) {
      const v = mesh.ids[mesh.tris[t * 3 + c]];
      bagC[0] += rest[v * 3];
      bagC[1] += rest[v * 3 + 1];
      bagC[2] += rest[v * 3 + 2];
      bn++;
    }
  const across = unit(
    rimRest[cb * 3] - rimRest[ca * 3],
    rimRest[cb * 3 + 1] - rimRest[ca * 3 + 1],
    rimRest[cb * 3 + 2] - rimRest[ca * 3 + 2],
  );
  let fwd = unit(
    c0[0] - bagC[0] / Math.max(1, bn),
    c0[1] - bagC[1] / Math.max(1, bn),
    c0[2] - bagC[2] / Math.max(1, bn),
  );
  const fa = dot3(fwd, across);
  fwd = unit(fwd[0] - fa * across[0], fwd[1] - fa * across[1], fwd[2] - fa * across[2]);
  let up = unit(
    fwd[1] * across[2] - fwd[2] * across[1],
    fwd[2] * across[0] - fwd[0] * across[2],
    fwd[0] * across[1] - fwd[1] * across[0],
  );
  // (the character stands upright: its up is the frame's +y)
  if (up[1] < 0) up = [-up[0], -up[1], -up[2]];

  // 1. the jaw probe
  const teethGroup = pack.mouth?.groups.find((g) => g.name === 'teeth');
  if (!teethGroup) throw new Error('aosrig-splat: the head pack names no teeth');
  const m = pack.bindTransform;
  // up in the head's own frame, so a basis row (head-local) can be read along it
  const upH: [number, number, number] = [
    m[0] * up[0] + m[4] * up[1] + m[8] * up[2],
    m[1] * up[0] + m[5] * up[1] + m[9] * up[2],
    m[2] * up[0] + m[6] * up[1] + m[10] * up[2],
  ];
  const lane = (v: number, e: number, c: number): number => {
    const l = (v * E + e) * 3 + c;
    return halfToFloat((pack.basis[l >> 1] >>> ((l & 1) * 16)) & 0xffff) * pack.basisScale[e];
  };
  const tv = teethGroup.vertices;
  const reach = new Float64Array(tv.length);
  for (let k = 0; k < tv.length; k++)
    for (let e = 0; e < E; e++)
      reach[k] += Math.hypot(lane(tv[k], e, 0), lane(tv[k], e, 1), lane(tv[k], e, 2));
  let most = 0;
  for (const r of reach) most = Math.max(most, r);
  if (!(most > 0)) throw new Error('aosrig-splat: the expression does not move the teeth');
  const lowerIds: number[] = [];
  const probe = new Float64Array(E);
  for (let k = 0; k < tv.length; k++) {
    if (reach[k] < 0.5 * most) continue;
    lowerIds.push(tv[k]);
    for (let e = 0; e < E; e++)
      probe[e] +=
        lane(tv[k], e, 0) * upH[0] + lane(tv[k], e, 1) * upH[1] + lane(tv[k], e, 2) * upH[2];
  }
  let pl = 0;
  for (const x of probe) pl += x * x;
  pl = Math.sqrt(pl) || 1;
  for (let e = 0; e < E; e++) probe[e] /= pl;
  // the lower teeth's move under the probe, along up, in the character frame
  const tpos = new Float32Array(lowerIds.length * 3);
  createVertexExpression(pack, Uint32Array.from(lowerIds)).evaluate(probe, tpos);
  let jaw = 0;
  for (let k = 0; k < lowerIds.length; k++) {
    const v = lowerIds[k];
    for (let c = 0; c < 3; c++) jaw += (tpos[k * 3 + c] - rest[v * 3 + c]) * up[c];
  }
  jaw /= Math.max(1, lowerIds.length);
  if (!(Math.abs(jaw) > 1e-9)) throw new Error('aosrig-splat: the jaw probe does not move the jaw');

  // the rim's halves, and which follows the jaw
  const half = new Uint8Array(nr);
  for (let k = cb; k !== ca; k = (k + 1) % nr) half[k] = 1;
  const rimNow = new Float32Array(nr * 3);
  createVertexExpression(pack, mesh.rim).evaluate(probe, rimNow);
  const follow = [0, 0],
    count = [0, 0];
  for (let k = 0; k < nr; k++) {
    if (k === ca || k === cb) continue;
    let d = 0;
    for (let c = 0; c < 3; c++) d += (rimNow[k * 3 + c] - rimRest[k * 3 + c]) * up[c];
    follow[half[k]] += d / jaw;
    count[half[k]]++;
  }
  const lowerHalf = follow[0] / Math.max(1, count[0]) > follow[1] / Math.max(1, count[1]) ? 0 : 1;
  const lip = new Uint8Array(nr);
  for (let k = 0; k < nr; k++) lip[k] = k === ca || k === cb ? 2 : half[k] === lowerHalf ? 1 : 0;

  // 2. the candidates, in the mouth's frame
  const rt = new Float64Array(nr),
    rf = new Float64Array(nr);
  let tmin = Infinity,
    tmax = -Infinity;
  for (let k = 0; k < nr; k++) {
    const dx = rimRest[k * 3] - c0[0],
      dy = rimRest[k * 3 + 1] - c0[1],
      dz = rimRest[k * 3 + 2] - c0[2];
    rt[k] = dx * across[0] + dy * across[1] + dz * across[2];
    rf[k] = dx * fwd[0] + dy * fwd[1] + dz * fwd[2];
    tmin = Math.min(tmin, rt[k]);
    tmax = Math.max(tmax, rt[k]);
  }
  const order = Array.from(rt.keys()).sort((a, b) => rt[a] - rt[b]);
  const depthAt = (t: number): number => {
    // the rim's depth at this place across the mouth, between the rim points either side
    let lo = order[0],
      hi = order[order.length - 1];
    for (const k of order) {
      if (rt[k] <= t) lo = k;
      if (rt[k] >= t) {
        hi = k;
        break;
      }
    }
    const span = rt[hi] - rt[lo];
    return span > 1e-9 ? rf[lo] + ((t - rt[lo]) / span) * (rf[hi] - rf[lo]) : rf[lo];
  };
  const cand: number[] = [];
  const ct: number[] = [],
    ch: number[] = [];
  const p: [number, number, number] = [0, 0, 0];
  for (let i = 0; i < splats.count; i++) {
    if (!(splats.bindings[i * 28 + 11] > 0)) continue;
    splats.position(i, p);
    const dx = p[0] - c0[0],
      dy = p[1] - c0[1],
      dz = p[2] - c0[2];
    if (Math.abs(dx) > 0.04 || Math.abs(dy) > 0.04 || Math.abs(dz) > 0.04) continue;
    if (splats.opacity(i) < 0.25) continue;
    const t = dx * across[0] + dy * across[1] + dz * across[2];
    const h = dx * up[0] + dy * up[1] + dz * up[2];
    const f = dx * fwd[0] + dy * fwd[1] + dz * fwd[2];
    if (t < tmin * 0.95 || t > tmax * 0.95 || Math.abs(h) > 0.012) continue;
    const fr = depthAt(t);
    if (f - fr < -0.012 || f - fr > 0.004) continue;
    cand.push(i);
    ct.push(t);
    ch.push(h);
  }
  const nc = cand.length;
  const all = gather(cand, splats);
  // which candidates move with the jaw
  const probePos = new Float32Array(all.verts.length * 3);
  createVertexExpression(pack, all.verts).evaluate(probe, probePos);
  const moved = moveBoundPoints(all, probePos, new Float64Array(nc * 3));
  const lower = new Uint8Array(nc);
  for (let j = 0; j < nc; j++) {
    let d = 0;
    for (let c = 0; c < 3; c++) d += (moved[j * 3 + c] - all.rest[j * 3 + c]) * up[c];
    lower[j] = d / jaw >= JAW_FOLLOW ? 1 : 0;
  }

  // 3. each station's two edges at rest, and its own lip's edge points
  const pairs: [number, number, number][] = [];
  const mid = new Float64Array(nr * 3);
  const hasMid = new Uint8Array(nr);
  const own = new Uint8Array(nr);
  const edgeOf = (k: number, wantLower: number): number[] => {
    let best = wantLower ? -Infinity : Infinity;
    for (let j = 0; j < nc; j++) {
      if (lower[j] !== wantLower || Math.abs(ct[j] - rt[k]) > STATION_REACH_M) continue;
      best = wantLower ? Math.max(best, ch[j]) : Math.min(best, ch[j]);
    }
    if (!Number.isFinite(best)) return [];
    const out: number[] = [];
    for (let j = 0; j < nc; j++) {
      if (lower[j] !== wantLower || Math.abs(ct[j] - rt[k]) > STATION_REACH_M) continue;
      if (wantLower ? ch[j] > best - EDGE_BAND_M : ch[j] < best + EDGE_BAND_M) out.push(j);
    }
    return out;
  };
  const mean = (js: number[]): [number, number, number] => {
    const s: [number, number, number] = [0, 0, 0];
    let ws = 0;
    for (const j of js) {
      const w = splats.opacity(cand[j]);
      ws += w;
      for (let c = 0; c < 3; c++) s[c] += all.rest[j * 3 + c] * w;
    }
    return [s[0] / ws, s[1] / ws, s[2] / ws];
  };
  for (let k = 0; k < nr; k++) {
    const lowerEdge = edgeOf(k, 1),
      upperEdge = edgeOf(k, 0);
    if (lowerEdge.length && upperEdge.length) {
      const a = mean(lowerEdge),
        b = mean(upperEdge);
      for (let c = 0; c < 3; c++) mid[k * 3 + c] = 0.5 * (a[c] + b[c]);
      hasMid[k] = 1;
    }
    if (lip[k] === 2) continue;
    const mine = lip[k] === 1 ? lowerEdge : upperEdge;
    for (const j of mine) pairs.push([j, k, splats.opacity(cand[j])]);
    if (mine.length) own[k] = 1;
  }
  const upperCount = new Set(pairs.filter(([, k]) => lip[k] === 0).map(([j]) => j)).size;
  const lowerCount = new Set(pairs.filter(([, k]) => lip[k] === 1).map(([j]) => j)).size;
  if (!upperCount || !lowerCount || !hasMid.includes(1))
    throw new Error(
      "aosrig-splat: a lip has no points at its edge (the face's points do not reach the mouth)",
    );
  // stations without their own points borrow the nearest station of the same lip that has
  const borrow = new Uint16Array(nr);
  for (let k = 0; k < nr; k++) {
    borrow[k] = k;
    if (lip[k] === 2 || own[k]) continue;
    let bd = Infinity;
    for (let j = 0; j < nr; j++)
      if (lip[j] === lip[k] && own[j] && Math.abs(rt[j] - rt[k]) < bd) {
        bd = Math.abs(rt[j] - rt[k]);
        borrow[k] = j;
      }
  }
  // the rest point: the rim point moved along up to the two edges' midline (the nearest
  // station's where this one found only one edge)
  const base = new Float64Array(nr * 3);
  for (let k = 0; k < nr; k++) {
    let src = k;
    if (!hasMid[k]) {
      let bd = Infinity;
      for (let j = 0; j < nr; j++)
        if (hasMid[j] && Math.abs(rt[j] - rt[k]) < bd) {
          bd = Math.abs(rt[j] - rt[k]);
          src = j;
        }
    }
    let hm = 0,
      hr = 0;
    for (let c = 0; c < 3; c++) {
      hm += (mid[src * 3 + c] - c0[c]) * up[c];
      hr += (rimRest[k * 3 + c] - c0[c]) * up[c];
    }
    for (let c = 0; c < 3; c++) base[k * 3 + c] = rimRest[k * 3 + c] + (hm - hr) * up[c];
  }
  // the edge points only
  const used = Array.from(new Set(pairs.map(([j]) => j))).sort((a, b) => a - b);
  const index = new Map(used.map((j, i) => [j, i]));
  const edge = gather(
    used.map((j) => cand[j]),
    splats,
  );
  const middle = new Uint8Array(nr);
  const width = tmax - tmin;
  for (let k = 0; k < nr; k++)
    middle[k] = Math.abs(rt[k] - (tmin + tmax) / 2) < 0.2 * width ? 1 : 0;
  return {
    across,
    up,
    forward: fwd,
    lip,
    base,
    ...edge,
    pairPoint: Uint32Array.from(pairs.map(([j]) => index.get(j) ?? 0)),
    pairStation: Uint16Array.from(pairs.map(([, k]) => k)),
    pairWeight: Float32Array.from(pairs.map(([, , w]) => w)),
    borrow,
    middle,
    counts: { upper: upperCount, lower: lowerCount, candidates: nc },
  };
}

/**
 * The window's points this frame from the lips' edge points: each station at its rest point
 * moved by the (opacity-weighted) mean move of its lip's edge points, borrowed from the
 * nearest station of its lip when it has none, the corners halfway between their
 * neighbours, then smoothed along each lip over five stations.
 *
 * @param e The edges.
 * @param moved x y z per edge point, now (`moveBoundPoints`).
 * @param out x y z per station, written.
 * @param scratch At least 7 x stations numbers.
 * @returns How far apart the lips' points are in the middle of the mouth, past rest (metres).
 */
export function lipEdgePoints(
  e: LipEdges,
  moved: Float64Array,
  out: Float64Array,
  scratch: Float64Array,
): number {
  const nr = e.lip.length;
  const acc = scratch.subarray(0, nr * 3);
  const sm = scratch.subarray(nr * 3, nr * 6);
  const ws = scratch.subarray(nr * 6, nr * 7);
  acc.fill(0);
  ws.fill(0);
  for (let q = 0; q < e.pairPoint.length; q++) {
    const j = e.pairPoint[q],
      k = e.pairStation[q],
      w = e.pairWeight[q];
    for (let c = 0; c < 3; c++) acc[k * 3 + c] += (moved[j * 3 + c] - e.rest[j * 3 + c]) * w;
    ws[k] += w;
  }
  for (let k = 0; k < nr; k++) if (ws[k] > 0) for (let c = 0; c < 3; c++) acc[k * 3 + c] /= ws[k];
  for (let k = 0; k < nr; k++) {
    const b = e.borrow[k];
    if (b !== k) for (let c = 0; c < 3; c++) acc[k * 3 + c] = acc[b * 3 + c];
  }
  for (let k = 0; k < nr; k++) {
    if (e.lip[k] !== 2) continue;
    const a = (k + nr - 1) % nr,
      b = (k + 1) % nr;
    for (let c = 0; c < 3; c++) acc[k * 3 + c] = 0.5 * (acc[a * 3 + c] + acc[b * 3 + c]);
  }
  for (let k = 0; k < nr; k++) {
    let n = 0;
    for (let c = 0; c < 3; c++) sm[k * 3 + c] = 0;
    for (let d = -2; d <= 2; d++) {
      const j = (k + d + nr) % nr;
      if (e.lip[k] !== 2 && e.lip[j] !== e.lip[k] && e.lip[j] !== 2) continue;
      for (let c = 0; c < 3; c++) sm[k * 3 + c] += acc[j * 3 + c];
      n++;
    }
    for (let c = 0; c < 3; c++) out[k * 3 + c] = e.base[k * 3 + c] + sm[k * 3 + c] / n;
  }
  let hu = 0,
    nu = 0,
    hl = 0,
    nl = 0;
  for (let k = 0; k < nr; k++) {
    if (!e.middle[k] || e.lip[k] === 2) continue;
    const h = dot3(out, e.up, k * 3) - dot3(e.base, e.up, k * 3);
    if (e.lip[k] === 0) {
      hu += h;
      nu++;
    } else {
      hl += h;
      nl++;
    }
  }
  return (nu ? hu / nu : 0) - (nl ? hl / nl : 0);
}

/**
 * How much of the inside shows, 0..1, from how far apart the lips' points are in the middle:
 * nothing below `start`, all from `full`, smooth between.
 *
 * @param gap Metres (`lipEdgePoints`).
 * @param start Where the inside starts to show, metres (`OPEN_START_M`).
 * @param full Where it shows fully, metres (`OPEN_FULL_M`).
 * @returns The strength.
 */
export function openStrength(gap: number, start = OPEN_START_M, full = OPEN_FULL_M): number {
  const x = Math.min(1, Math.max(0, (gap - start) / Math.max(1e-6, full - start)));
  return x * x * (3 - 2 * x);
}

/**
 * Hold each lip's window points on their side of the lips' middle line: in the window's own
 * directions (across the mouth, the face's up; each point keeps its depth), where the upper
 * lip's points come below the lower lip's the window closes there instead of folding over
 * itself. Also gives each point its middle-line point (the corners are their own).
 *
 * @param win The window's points and its centre last (`windowPoints`), x y z.
 * @param lip Per point: 0 upper lip, 1 lower lip, 2 a corner.
 * @param across The mouth's across (unit).
 * @param up The face's up (unit).
 * @param bound x y z per rim point, written: the held points.
 * @param middle x y z per rim point, written: each one's middle-line point.
 * @returns Nothing.
 */
export function holdLips(
  win: ArrayLike<number>,
  lip: ArrayLike<number>,
  across: readonly [number, number, number],
  up: readonly [number, number, number],
  bound: Float32Array,
  middle: Float32Array,
): void {
  const n = win.length / 3 - 1;
  const [ax, ay, az] = across;
  const [ux, uy, uz] = up;
  const t = new Float64Array(n),
    h = new Float64Array(n);
  for (let k = 0; k < n; k++) {
    t[k] = win[k * 3] * ax + win[k * 3 + 1] * ay + win[k * 3 + 2] * az;
    h[k] = win[k * 3] * ux + win[k * 3 + 1] * uy + win[k * 3 + 2] * uz;
  }
  // each lip's height as a function of across, from its own points (and the corners)
  const heightOf = (which: number, at: number): number => {
    let lo = -1,
      hi = -1;
    for (let k = 0; k < n; k++) {
      if (lip[k] !== which && lip[k] !== 2) continue;
      if (t[k] <= at && (lo < 0 || t[k] > t[lo])) lo = k;
      if (t[k] >= at && (hi < 0 || t[k] < t[hi])) hi = k;
    }
    if (lo < 0) return h[hi];
    if (hi < 0 || t[hi] === t[lo]) return h[lo];
    return h[lo] + ((at - t[lo]) / (t[hi] - t[lo])) * (h[hi] - h[lo]);
  };
  for (let k = 0; k < n; k++) {
    const mid = lip[k] === 2 ? h[k] : 0.5 * (heightOf(0, t[k]) + heightOf(1, t[k]));
    const hs = lip[k] === 0 ? Math.max(h[k], mid) : lip[k] === 1 ? Math.min(h[k], mid) : h[k];
    for (let c = 0; c < 3; c++) {
      bound[k * 3 + c] = win[k * 3 + c] + (hs - h[k]) * up[c];
      middle[k * 3 + c] = win[k * 3 + c] + (mid - h[k]) * up[c];
    }
  }
}

/**
 * The soft rim, on the screen: each window point moved half the feather out and half in,
 * across the outline (its normal in pixels, away from its middle-line point; the corners away
 * from the window's middle), never in past the middle line — so the mask ramps from 0 on the
 * outer ring to 1 on the inner one over the same number of pixels from any side. Where the
 * lips are barely apart the inner ring's own value falls with the gap there, so a closed
 * stretch of the lips shows nothing rather than a thin line.
 *
 * @param p x y per rim point, pixels (the held window points).
 * @param m x y per rim point, pixels (their middle-line points).
 * @param lip Per point: 0 upper lip, 1 lower lip, 2 a corner.
 * @param feather The ramp's width in pixels.
 * @param outer x y per rim point, written.
 * @param inner x y per rim point, written.
 * @param innerValue The mask's value on the inner ring per rim point, written (0..1).
 * @returns Nothing.
 */
export function screenRings(
  p: ArrayLike<number>,
  m: ArrayLike<number>,
  lip: ArrayLike<number>,
  feather: number,
  outer: Float32Array,
  inner: Float32Array,
  innerValue: Float32Array,
): void {
  const n = lip.length;
  let cx = 0,
    cy = 0;
  for (let k = 0; k < n; k++) {
    cx += p[k * 2] / n;
    cy += p[k * 2 + 1] / n;
  }
  const r = feather / 2;
  for (let k = 0; k < n; k++) {
    const a = (k + n - 1) % n,
      b = (k + 1) % n;
    const x = p[k * 2],
      y = p[k * 2 + 1];
    let nx: number, ny: number;
    let reach = Infinity;
    if (lip[k] === 2) {
      nx = x - cx;
      ny = y - cy;
    } else {
      const tx = p[b * 2] - p[a * 2],
        ty = p[b * 2 + 1] - p[a * 2 + 1];
      nx = -ty;
      ny = tx;
      const ox = x - m[k * 2],
        oy = y - m[k * 2 + 1];
      const len = Math.hypot(nx, ny);
      if (len < 1e-9) {
        nx = ox;
        ny = oy;
      } else if (nx * ox + ny * oy < 0) {
        nx = -nx;
        ny = -ny;
      }
      reach = Math.hypot(ox, oy);
    }
    const len = Math.hypot(nx, ny) || 1;
    nx /= len;
    ny /= len;
    const inward = Math.min(r, reach);
    outer[k * 2] = x + nx * r;
    outer[k * 2 + 1] = y + ny * r;
    inner[k * 2] = x - nx * inward;
    inner[k * 2 + 1] = y - ny * inward;
    const g = lip[k] === 2 ? 0 : Math.min(1, (2 * reach) / (2 * feather));
    innerValue[k] = g * g * (3 - 2 * g);
  }
}

/**
 * The soft rim's triangles over outer ring (0..n-1) and inner ring (n..2n-1): the inside of
 * the inner ring as a strip between the two lips' chains (each runs corner to corner, in
 * order across the mouth, so the strip never folds however the lips curve), then the band
 * between the rings.
 *
 * @param lip Per rim point: 0 upper lip, 1 lower lip, 2 a corner (exactly two).
 * @param t Each rim point's place across the mouth (at rest is enough: the order is kept).
 * @returns Triangle indices.
 */
export function featherTriangles(lip: ArrayLike<number>, t: ArrayLike<number>): Uint32Array {
  const n = lip.length;
  const corners: number[] = [];
  for (let k = 0; k < n; k++) if (lip[k] === 2) corners.push(k);
  if (corners.length !== 2) throw new Error('aosrig-splat: the window needs exactly two corners');
  const [c0, c1] = corners;
  const chainA: number[] = [];
  for (let k = c0; ; k = (k + 1) % n) {
    chainA.push(k);
    if (k === c1) break;
  }
  const chainB: number[] = [];
  for (let k = c0; ; k = (k + n - 1) % n) {
    chainB.push(k);
    if (k === c1) break;
  }
  const dir = t[c1] >= t[c0] ? 1 : -1;
  const out: number[] = [];
  let i = 0,
    j = 0;
  while (i < chainA.length - 1 || j < chainB.length - 1) {
    const nextA = i < chainA.length - 1 ? chainA[i + 1] : -1;
    const nextB = j < chainB.length - 1 ? chainB[j + 1] : -1;
    const takeA = nextB < 0 || (nextA >= 0 && dir * t[nextA] <= dir * t[nextB]);
    if (takeA) {
      out.push(n + chainA[i], n + chainB[j], n + nextA);
      i++;
    } else {
      out.push(n + chainA[i], n + chainB[j], n + nextB);
      j++;
    }
  }
  for (let k = 0; k < n; k++) {
    const k1 = (k + 1) % n;
    out.push(k, k1, n + k1, k, n + k1, n + k);
  }
  return Uint32Array.from(out);
}

/**
 * How much light reaches each mesh vertex, 0..1, from how deep it lies behind the lips (the
 * rim's centre, back toward the bag's): the front teeth nearly all, the back of the bag
 * little. A mouth is dark inside because the lips and cheeks shade it.
 *
 * @param mesh The mouth mesh.
 * @param rest x y z per head vertex, at rest.
 * @returns One factor per mesh vertex.
 */
export function mouthShade(mesh: MouthMesh, rest: ArrayLike<number>): Float32Array {
  let rx = 0,
    ry = 0,
    rz = 0;
  for (const v of mesh.rim) {
    rx += rest[v * 3];
    ry += rest[v * 3 + 1];
    rz += rest[v * 3 + 2];
  }
  rx /= mesh.rim.length;
  ry /= mesh.rim.length;
  rz /= mesh.rim.length;
  let bx = 0,
    by = 0,
    bz = 0,
    bn = 0;
  for (let t = mesh.partStart[mesh.bag]; t < mesh.partStart[mesh.bag + 1]; t++)
    for (let c = 0; c < 3; c++) {
      const v = mesh.ids[mesh.tris[t * 3 + c]];
      bx += rest[v * 3];
      by += rest[v * 3 + 1];
      bz += rest[v * 3 + 2];
      bn++;
    }
  const out = new Float32Array(mesh.ids.length).fill(1);
  if (!bn) return out;
  let dx = bx / bn - rx,
    dy = by / bn - ry,
    dz = bz / bn - rz;
  const len = Math.hypot(dx, dy, dz);
  if (len < 1e-9) return out;
  dx /= len;
  dy /= len;
  dz /= len;
  for (let i = 0; i < mesh.ids.length; i++) {
    const v = mesh.ids[i];
    const depth =
      (rest[v * 3] - rx) * dx + (rest[v * 3 + 1] - ry) * dy + (rest[v * 3 + 2] - rz) * dz;
    out[i] = Math.max(SHADE_MIN, Math.min(1, 1 - Math.max(0, depth) / SHADE_DEPTH_M));
  }
  return out;
}

/**
 * The rim's two corners: the two of its points farthest apart, at rest.
 *
 * @param rim x y z per rim point.
 * @returns Their positions in the rim.
 */
export function windowCorners(rim: ArrayLike<number>): [number, number] {
  const n = rim.length / 3;
  let best = -1;
  let pair: [number, number] = [0, 0];
  for (let a = 0; a < n; a++)
    for (let b = a + 1; b < n; b++) {
      const d =
        (rim[a * 3] - rim[b * 3]) ** 2 +
        (rim[a * 3 + 1] - rim[b * 3 + 1]) ** 2 +
        (rim[a * 3 + 2] - rim[b * 3 + 2]) ** 2;
      if (d > best) {
        best = d;
        pair = [a, b];
      }
    }
  return pair;
}

/**
 * Each rim point's offset at rest from the line between the lips: half the rest opening it
 * stands for. The rim splits at its corners into two lips; a point's partner is the other
 * lip at the same place across the mouth; the corners' offsets are nothing.
 *
 * @param rim x y z per rim point, at rest.
 * @param corners From {@link windowCorners}.
 * @returns x y z per rim point.
 */
export function windowRest(rim: ArrayLike<number>, corners: [number, number]): Float32Array {
  const n = rim.length / 3;
  const P = (k: number): [number, number, number] => [rim[k * 3], rim[k * 3 + 1], rim[k * 3 + 2]];
  const [a, b] = corners;
  const A = P(a),
    B = P(b);
  let ax = B[0] - A[0],
    ay = B[1] - A[1],
    az = B[2] - A[2];
  const len = Math.hypot(ax, ay, az) || 1;
  ax /= len;
  ay /= len;
  az /= len;
  const across = (k: number): number => {
    const p = P(k);
    return (p[0] - A[0]) * ax + (p[1] - A[1]) * ay + (p[2] - A[2]) * az;
  };
  const lipOne: number[] = [];
  const lipTwo: number[] = [];
  for (let k = a; ; k = (k + 1) % n) {
    lipOne.push(k);
    if (k === b) break;
  }
  for (let k = b; ; k = (k + 1) % n) {
    lipTwo.push(k);
    if (k === a) break;
  }
  const out = new Float32Array(n * 3);
  const partner = (k: number, other: number[]): [number, number, number] => {
    const t = across(k);
    for (let i = 0; i + 1 < other.length; i++) {
      const t0 = across(other[i]),
        t1 = across(other[i + 1]);
      if ((t - t0) * (t - t1) <= 0 && t0 !== t1) {
        const f = (t - t0) / (t1 - t0);
        const p0 = P(other[i]),
          p1 = P(other[i + 1]);
        return [
          p0[0] + f * (p1[0] - p0[0]),
          p0[1] + f * (p1[1] - p0[1]),
          p0[2] + f * (p1[2] - p0[2]),
        ];
      }
    }
    return P(k);
  };
  for (const [lip, other] of [
    [lipOne, lipTwo],
    [lipTwo, lipOne],
  ] as const) {
    for (const k of lip) {
      if (k === a || k === b) continue;
      const p = P(k);
      const q = partner(k, other);
      for (let c = 0; c < 3; c++) out[k * 3 + c] = 0.5 * (p[c] - q[c]);
    }
  }
  return out;
}

/**
 * The window's points: the rim less its rest offsets, then its centre (point `n`); drawn in
 * toward the centre across the mouth to `side` of the width, and up and down by `edge`
 * (never past the centre line).
 *
 * @param rim x y z per rim point, now.
 * @param out `(n + 1) * 3` numbers, written.
 * @param restOff From {@link windowRest}, or null for none.
 * @param corners From {@link windowCorners}, or null to leave the width alone.
 * @param side How much of the width to keep.
 * @param edge How far to draw the top and bottom in (metres).
 * @returns Nothing; `out` is written.
 */
export function windowPoints(
  rim: ArrayLike<number>,
  out: Float32Array,
  restOff: Float32Array | null,
  corners: [number, number] | null = null,
  side = 1,
  edge = 0,
): void {
  const n = rim.length / 3;
  let cx = 0,
    cy = 0,
    cz = 0;
  for (let k = 0; k < n; k++) {
    for (let c = 0; c < 3; c++)
      out[k * 3 + c] = rim[k * 3 + c] - (restOff ? restOff[k * 3 + c] : 0);
    cx += out[k * 3];
    cy += out[k * 3 + 1];
    cz += out[k * 3 + 2];
  }
  cx /= n;
  cy /= n;
  cz /= n;
  out[n * 3] = cx;
  out[n * 3 + 1] = cy;
  out[n * 3 + 2] = cz;
  if (!corners || (side === 1 && edge === 0)) return;
  const [a, b] = corners;
  let ax = out[b * 3] - out[a * 3],
    ay = out[b * 3 + 1] - out[a * 3 + 1],
    az = out[b * 3 + 2] - out[a * 3 + 2];
  const len = Math.hypot(ax, ay, az);
  if (len < 1e-9) return;
  ax /= len;
  ay /= len;
  az /= len;
  for (let k = 0; k < n; k++) {
    let dx = out[k * 3] - cx,
      dy = out[k * 3 + 1] - cy,
      dz = out[k * 3 + 2] - cz;
    const t = dx * ax + dy * ay + dz * az;
    const f = (side - 1) * t;
    out[k * 3] += f * ax;
    out[k * 3 + 1] += f * ay;
    out[k * 3 + 2] += f * az;
    if (edge > 0) {
      dx -= t * ax;
      dy -= t * ay;
      dz -= t * az;
      const h = Math.hypot(dx, dy, dz);
      const g = h > 1e-9 ? Math.min(edge, h) / h : 0;
      out[k * 3] -= g * dx;
      out[k * 3 + 1] -= g * dy;
      out[k * 3 + 2] -= g * dz;
    }
  }
}
