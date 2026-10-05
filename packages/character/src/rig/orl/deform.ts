// ORL blendshape + linear-blend-skinning deform — the CPU path, and the reference
// the WGSL pass is held to.
//
// They are SIBLINGS, not ports of each other: each exists because its runtime
// cannot host the other, and `test/orlDeform.test.ts` pins them to one committed
// set of numbers so a change here cannot land alone.
//
// NO three.js import, so the node tests exercise the exact code that ships.
//
// Inputs are the baked bundle buffers (the members of the character's
// `orl_pack.bin`) plus per-frame ORL outputs (`getJointOutputs` /
// `getBlendShapeOutputs`). Output: `Float32Array[V*3]` in CENTIMETRES (the same
// units as the bundle / DNA). The caller scales to metres at the render boundary.
//
// Math (mirrors the reference exactly):
//   verts   = neutral + Σ_ch bsOut[ch] · delta[ch]                   (blendshapes)
//   local_j = T(t_n+t_d) · R_xyz(r_n) · R_xyz(r_d) · S(1+s_d)        (posed local)
//   world_j = (parent==j) ? local_j : world_parent · local_j         (forward walk)
//   skin_j  = world_j · inverseBind_j
//   v'      = Σ_i w_i · skin_{joint_i} · [v,1]                       (LBS)
// Rotations: Maya extrinsic 'xyz' in degrees -> R = Rz·Ry·Rx (column-vector).
// Matrices are flat row-major Float64Array(16) to match numpy indexing.
//
// Ported from aos-threejs-poc/src/lib/orl/deform.js @ cdd63b10

import type { BlendshapeTarget } from './csr.js';
import { packSkinRows } from '../skinMath.js';

/** `manifest.json` inside an ORL pack. */
export interface OrlManifest {
  V: number;
  numJoints: number;
  maxInfluence: number;
  numBlendShapeChannels: number;
  numBlendShapeTargets?: number;
  jointNames?: string[];
}

/** The `.bin` members, as ArrayBuffers keyed by their stem. */
export interface OrlBuffers {
  neutral_pos: ArrayBuffer;
  joint_neutral: ArrayBuffer;
  joint_parents: ArrayBuffer;
  inverse_bind: ArrayBuffer;
  skin_idx: ArrayBuffer;
  skin_w: ArrayBuffer;
  bs_index: ArrayBuffer;
  bs_delta: ArrayBuffer;
}

/** What `createDeformer` hands back. */
export interface OrlDeformer {
  readonly V: number;
  readonly J: number;
  readonly maxInf: number;
  /** Neutral vertices, cm. */
  readonly neutral: Float32Array;
  /** Full CPU deform: blendshapes onto the neutral, then LBS. Reused scratch. */
  deform(jointOut: Float32Array, bsOut: Float32Array): Float32Array;
  /** Steps 2+3 alone: posed world matrices -> `skin = world · invBind`. */
  computeSkin(jointOut: Float32Array): Float64Array;
  /** Skin matrices as PACKED ROWS: 12 floats per joint, what the WGSL deform reads. */
  computeSkinRows(jointOut: Float32Array): Float32Array;
  /**
   * Bumped every time `computeSkin` actually recomputed. A caller holding the
   * previous value knows `world`, `computeSkin`'s result and `computeSkinRows`'s
   * rows are all byte-identical to what it already has.
   */
  readonly skinGeneration: number;
  /**
   * Posed world matrices as a LIVE VIEW, not a copy — the rigid-shell deform drives
   * a branch the DNA does not skin from joint MOTION alone, so it needs `world_j`,
   * not `skin_j`. Valid only immediately after a `computeSkin()` call.
   */
  readonly world: Float64Array;
  readonly buffers: {
    neutral: Float32Array;
    skinIdx: Uint16Array;
    skinW: Float32Array;
    bsIndex: Uint16Array;
    bsDelta: Float32Array;
  };
  readonly bsTargets: readonly BlendshapeTarget[];
}

// Maya extrinsic xyz euler (degrees) -> 3x3 = Rz·Ry·Rx, written into the top-left
// of a row-major 4x4 already holding translation/homogeneous row.
/**
 * Write a Maya extrinsic xyz euler as a rotation matrix.
 *
 * @param rx Rotation about x, in degrees.
 * @param ry Rotation about y, in degrees.
 * @param rz Rotation about z, in degrees.
 * @param out A row-major 4x4 whose upper-left 3x3 is overwritten with `Rz·Ry·Rx`.
 *   Its translation column and homogeneous row are left as they were.
 */
function deg2mat3(rx: number, ry: number, rz: number, out: Float64Array): void {
  const d = Math.PI / 180;
  const cx = Math.cos(rx * d);
  const sx = Math.sin(rx * d);
  const cy = Math.cos(ry * d);
  const sy = Math.sin(ry * d);
  const cz = Math.cos(rz * d);
  const sz = Math.sin(rz * d);
  // Ry·Rx first (call it A), then Rz·A.
  // Rx = [[1,0,0],[0,cx,-sx],[0,sx,cx]]
  // Ry = [[cy,0,sy],[0,1,0],[-sy,0,cy]]
  const a00 = cy;
  const a01 = sy * sx;
  const a02 = sy * cx;
  const a10 = 0;
  const a11 = cx;
  const a12 = -sx;
  const a20 = -sy;
  const a21 = cy * sx;
  const a22 = cy * cx;
  // Rz = [[cz,-sz,0],[sz,cz,0],[0,0,1]]; R = Rz·A
  out[0] = cz * a00 - sz * a10;
  out[1] = cz * a01 - sz * a11;
  out[2] = cz * a02 - sz * a12;
  out[4] = sz * a00 + cz * a10;
  out[5] = sz * a01 + cz * a11;
  out[6] = sz * a02 + cz * a12;
  out[8] = a20;
  out[9] = a21;
  out[10] = a22;
}

/**
 * Build a deformer from already-fetched bundle data.
 *
 * @param manifest Parsed `manifest.json`.
 * @param bufs The `.bin` members.
 * @param bsTargets Parsed `bs_targets.json`.
 * @returns The deformer, with its per-frame scratch already allocated. The int8
 *   blendshape deltas are dequantized here, once, so the per-frame loop stays fp32.
 */
export function createDeformer(
  manifest: OrlManifest,
  bufs: OrlBuffers,
  bsTargets: readonly BlendshapeTarget[],
): OrlDeformer {
  const V = manifest.V;
  const J = manifest.numJoints;
  const maxInf = manifest.maxInfluence;

  const neutral = new Float32Array(bufs.neutral_pos); // [V*3] cm
  const jointNeutral = new Float32Array(bufs.joint_neutral); // [J*9]
  const parents = new Int32Array(bufs.joint_parents); // [J]

  // The hierarchy must be ROOTED and TOPOLOGICALLY ORDERED. computeSkin walks
  // joints once, front to back, reading world[parent] before writing world[j], and
  // `world` is scratch REUSED ACROSS FRAMES — so a parent that comes after its
  // child reads LAST FRAME's matrix for it, propagated to every descendant: no
  // exception, no NaN, just a face posed off a stale parent. An index past J reads
  // undefined and poisons the pose with NaN instead. The bake refuses such a DNA,
  // but a pack can arrive from anywhere, so check it where the assumption is used.
  if (parents.length !== J) {
    throw new Error(
      `[orl] joint_parents has ${String(parents.length)} entries, expected ${String(J)}`,
    );
  }
  for (let j = 0; j < J; j++) {
    const p = parents[j];
    if (p < 0 || p >= J) {
      throw new Error(
        `[orl] joint ${String(j)} has parent ${String(p)}, outside [0, ${String(J)})`,
      );
    }
    if (p > j) {
      throw new Error(
        `[orl] joint hierarchy is not topologically ordered: joint ${String(j)} has parent ${String(p)}, ` +
          'which comes after it — the forward walk would read a stale matrix for it and every descendant',
      );
    }
  }
  const invBind = new Float32Array(bufs.inverse_bind); // [J*16] row-major
  const skinIdx = new Uint16Array(bufs.skin_idx); // [V*maxInf]
  const bsIndex = new Uint16Array(bufs.bs_index); // [sumCount]
  const skinW = new Float32Array(bufs.skin_w); // [V*maxInf] (fp32: LBS-sensitive)

  // Blendshape deltas ship as int8 with a per-target scale -> dequant to fp32 once
  // at load (keeps the per-frame loop identical to the float32 path).
  const bsQ = new Int8Array(bufs.bs_delta); // [sumCount*3]
  const bsDelta = new Float32Array(bsQ.length);
  // The runs must TILE bsQ — contiguous, no gap, no overlap. Checked rather than
  // assumed: a gap leaves bsDelta at zero there, so those deltas silently vanish
  // from every posed frame, which is not a crash and not visible in a log.
  let covered = 0;
  for (let t = 0; t < bsTargets.length; t++) {
    const s = bsTargets[t].scale ?? 0;
    if (bsTargets[t].offset !== covered) {
      throw new Error(
        `[orl] bs_targets do not tile bs_delta: target for channel ${String(bsTargets[t].channel)} ` +
          `starts at ${String(bsTargets[t].offset)}, expected ${String(covered)}`,
      );
    }
    const start = bsTargets[t].offset * 3;
    const end = start + bsTargets[t].count * 3;
    for (let i = start; i < end; i++) bsDelta[i] = bsQ[i] * s;
    covered = bsTargets[t].offset + bsTargets[t].count;
  }
  if (covered * 3 !== bsQ.length) {
    throw new Error(
      `[orl] bs_targets cover ${String(covered)} of ${String(bsQ.length / 3)} blendshape entries — the tail would stay zero`,
    );
  }

  // Scratch reused across frames.
  const verts = new Float32Array(V * 3); // blendshaped neutral (cm)
  const world = new Float64Array(J * 16); // posed world matrices
  const skin = new Float64Array(J * 16); // world · invBind
  const out = new Float32Array(V * 3); // final posed verts (cm)
  const L = new Float64Array(16); // per-joint local scratch
  const R = new Float64Array(16); // per-joint rotation scratch
  L[15] = 1;
  R[15] = 1;

  // The jointOut this solve was last run at, plus a counter the GPU deform gates its
  // uniform upload on. `orlRig.evaluateRig` already skips the 870-joint RigLogic
  // solve when the controls repeat, but it hands back a FRESH VIEW onto the wasm
  // heap every call, so nothing downstream could tell — and a still head paid for
  // 870 euler->matrix builds and 1,740 4x4 products every frame anyway.
  const lastJointOut = new Float32Array(J * 9);
  let haveSkin = false;
  let skinGeneration = 0;

  /**
   * Steps 2+3: posed local matrices, a forward walk to world, then `world·invBind`.
   *
   * MEMOISED on the contents of `jointOut`: an unchanged solve returns the same
   * scratch without recomputing, so a still character costs one J*9 compare rather
   * than 870 euler->matrix builds. `world` is left holding the same matrices too,
   * which is what makes the rigid-shell path safe to memoise with it.
   *
   * @param jointOut ORL's `getJointOutputs()`: 9 floats per joint — translate delta
   *   (cm), rotate delta (degrees), scale delta (added to 1).
   * @returns The reused `skin` scratch: J row-major 4x4 matrices. `world` holds the
   *   posed world matrices from the same call.
   */
  function computeSkin(jointOut: Float32Array): Float64Array {
    // Unchanged inputs mean unchanged `world` and `skin`, both of which are scratch
    // this function owns and nothing else writes.
    let moved = !haveSkin;
    const n = Math.min(jointOut.length, lastJointOut.length);
    for (let i = 0; i < n; i++) {
      const previous = lastJointOut[i];
      lastJointOut[i] = jointOut[i];
      if (lastJointOut[i] !== previous) moved = true;
    }
    if (!moved) return skin;
    haveSkin = true;
    skinGeneration += 1;

    // 2) posed world matrices (forward walk; parents topologically ordered)
    for (let j = 0; j < J; j++) {
      const jn = j * 9;
      const jo = j * 9;
      const tnx = jointNeutral[jn];
      const tny = jointNeutral[jn + 1];
      const tnz = jointNeutral[jn + 2];
      const rnx = jointNeutral[jn + 3];
      const rny = jointNeutral[jn + 4];
      const rnz = jointNeutral[jn + 5];
      const tdx = jointOut[jo];
      const tdy = jointOut[jo + 1];
      const tdz = jointOut[jo + 2];
      const rdx = jointOut[jo + 3];
      const rdy = jointOut[jo + 4];
      const rdz = jointOut[jo + 5];
      const sdx = jointOut[jo + 6];
      const sdy = jointOut[jo + 7];
      const sdz = jointOut[jo + 8];

      // L = R_xyz(r_n) · R_xyz(r_d) · S(1+s_d) (upper-left 3x3), then translation.
      deg2mat3(rnx, rny, rnz, L); // L3 = R(r_n)
      deg2mat3(rdx, rdy, rdz, R); // R3 = R(r_d)
      const l00 = L[0];
      const l01 = L[1];
      const l02 = L[2];
      const l10 = L[4];
      const l11 = L[5];
      const l12 = L[6];
      const l20 = L[8];
      const l21 = L[9];
      const l22 = L[10];
      const r00 = R[0];
      const r01 = R[1];
      const r02 = R[2];
      const r10 = R[4];
      const r11 = R[5];
      const r12 = R[6];
      const r20 = R[8];
      const r21 = R[9];
      const r22 = R[10];
      // m = L3 · R3, then columns scaled by S(1+s_d)
      const sx = 1 + sdx;
      const sy = 1 + sdy;
      const sz = 1 + sdz;
      L[0] = (l00 * r00 + l01 * r10 + l02 * r20) * sx;
      L[1] = (l00 * r01 + l01 * r11 + l02 * r21) * sy;
      L[2] = (l00 * r02 + l01 * r12 + l02 * r22) * sz;
      L[4] = (l10 * r00 + l11 * r10 + l12 * r20) * sx;
      L[5] = (l10 * r01 + l11 * r11 + l12 * r21) * sy;
      L[6] = (l10 * r02 + l11 * r12 + l12 * r22) * sz;
      L[8] = (l20 * r00 + l21 * r10 + l22 * r20) * sx;
      L[9] = (l20 * r01 + l21 * r11 + l22 * r21) * sy;
      L[10] = (l20 * r02 + l21 * r12 + l22 * r22) * sz;
      L[3] = tnx + tdx;
      L[7] = tny + tdy;
      L[11] = tnz + tdz;
      L[12] = 0;
      L[13] = 0;
      L[14] = 0;
      L[15] = 1;

      const wj = j * 16;
      const p = parents[j];
      if (p === j) {
        for (let e = 0; e < 16; e++) world[wj + e] = L[e];
      } else {
        // world[j] = world[p] · L (both row-major)
        const wp = p * 16;
        for (let i = 0; i < 4; i++) {
          const wpi = wp + i * 4;
          const a0 = world[wpi];
          const a1 = world[wpi + 1];
          const a2 = world[wpi + 2];
          const a3 = world[wpi + 3];
          world[wj + i * 4] = a0 * L[0] + a1 * L[4] + a2 * L[8] + a3 * L[12];
          world[wj + i * 4 + 1] = a0 * L[1] + a1 * L[5] + a2 * L[9] + a3 * L[13];
          world[wj + i * 4 + 2] = a0 * L[2] + a1 * L[6] + a2 * L[10] + a3 * L[14];
          world[wj + i * 4 + 3] = a0 * L[3] + a1 * L[7] + a2 * L[11] + a3 * L[15];
        }
      }
    }

    // 3) skin_j = world_j · invBind_j (invBind is Float32, multiply manually)
    for (let j = 0; j < J; j++) {
      const b = j * 16;
      for (let i = 0; i < 4; i++) {
        const wi = b + i * 4;
        const a0 = world[wi];
        const a1 = world[wi + 1];
        const a2 = world[wi + 2];
        const a3 = world[wi + 3];
        skin[b + i * 4] =
          a0 * invBind[b] + a1 * invBind[b + 4] + a2 * invBind[b + 8] + a3 * invBind[b + 12];
        skin[b + i * 4 + 1] =
          a0 * invBind[b + 1] + a1 * invBind[b + 5] + a2 * invBind[b + 9] + a3 * invBind[b + 13];
        skin[b + i * 4 + 2] =
          a0 * invBind[b + 2] + a1 * invBind[b + 6] + a2 * invBind[b + 10] + a3 * invBind[b + 14];
        skin[b + i * 4 + 3] =
          a0 * invBind[b + 3] + a1 * invBind[b + 7] + a2 * invBind[b + 11] + a3 * invBind[b + 15];
      }
    }

    return skin;
  }

  /**
   * The full CPU deform: blendshapes onto the neutral, then linear-blend skinning.
   *
   * @param jointOut ORL's `getJointOutputs()`, 9 floats per joint.
   * @param bsOut ORL's `getBlendShapeOutputs()`, one weight per blendshape channel.
   *   A zero-weight target is skipped outright.
   * @returns The reused `out` scratch: V posed vertices as xyz triples, in
   *   CENTIMETRES. Overwritten by the next call.
   */
  function deform(jointOut: Float32Array, bsOut: Float32Array): Float32Array {
    // 1) blendshapes onto neutral
    verts.set(neutral);
    for (let t = 0; t < bsTargets.length; t++) {
      const w = bsOut[bsTargets[t].channel];
      if (w === 0) continue;
      const o = bsTargets[t].offset;
      const c = bsTargets[t].count;
      for (let k = 0; k < c; k++) {
        const vi = bsIndex[o + k] * 3;
        const di = (o + k) * 3;
        verts[vi] += w * bsDelta[di];
        verts[vi + 1] += w * bsDelta[di + 1];
        verts[vi + 2] += w * bsDelta[di + 2];
      }
    }

    computeSkin(jointOut);

    // 4) LBS
    for (let v = 0; v < V; v++) {
      const vi = v * 3;
      const x = verts[vi];
      const y = verts[vi + 1];
      const z = verts[vi + 2];
      let ox = 0;
      let oy = 0;
      let oz = 0;
      const si = v * maxInf;
      for (let k = 0; k < maxInf; k++) {
        const w = skinW[si + k];
        if (w === 0) continue;
        const b = skinIdx[si + k] * 16;
        ox += w * (skin[b] * x + skin[b + 1] * y + skin[b + 2] * z + skin[b + 3]);
        oy += w * (skin[b + 4] * x + skin[b + 5] * y + skin[b + 6] * z + skin[b + 7]);
        oz += w * (skin[b + 8] * x + skin[b + 9] * y + skin[b + 10] * z + skin[b + 11]);
      }
      out[vi] = ox;
      out[vi + 1] = oy;
      out[vi + 2] = oz;
    }
    return out;
  }

  const skinRows = new Float32Array(J * 12);
  let rowsGeneration = -1;
  /**
   * The skin matrices in the packed form the WGSL deform binds.
   *
   * Memoised on the same solve `computeSkin` is: an unchanged `jointOut` returns
   * the rows already packed, untouched.
   *
   * @param jointOut ORL's `getJointOutputs()`, 9 floats per joint.
   * @returns The reused row buffer: 12 floats per joint — rows 0..2 of each
   *   row-major skin matrix, the bottom row dropped because it is always
   *   `[0,0,0,1]`. Overwritten by the next call that actually moves a joint.
   */
  function computeSkinRows(jointOut: Float32Array): Float32Array {
    computeSkin(jointOut);
    if (rowsGeneration === skinGeneration) return skinRows;
    rowsGeneration = skinGeneration;
    packSkinRows(skin, J, skinRows);
    return skinRows;
  }

  return {
    V,
    J,
    maxInf,
    neutral,
    deform,
    computeSkin,
    computeSkinRows,
    get skinGeneration() {
      return skinGeneration;
    },
    world,
    buffers: { neutral, skinIdx, skinW, bsIndex, bsDelta },
    bsTargets,
  };
}
