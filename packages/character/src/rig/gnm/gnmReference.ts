// The GNM head, on the CPU, in TypeScript.
//
// This is the correctness gate for `wgsl/gnm_blend.wgsl` and the only thing a node
// test can run: it reproduces `BakedHead.forward` (aosRig `aosrig/head/baked.py`)
// step for step, off the same `.aosrig` pack the shader reads, so the two cannot
// disagree about the layout, the fp16 dequantisation, the gaze convention or the
// LBS. `test/gnm.test.ts` holds it to `tools/gnm_reference.py`'s output at 1e-3 cm.
//
// It is NOT a runtime path. 383 × 17,821 × 3 multiply-adds per frame on the CPU is
// about 20 M operations, which is tens of milliseconds; the shader does it in a
// fraction of a millisecond. Calibration is the one caller (`runCpu`), once at load.

import { invertAffine } from '../skinMath.js';
import { halfToFloat, unpackHeadExt, type AosRigPack } from './gnmPack.js';

/** One eye's rotation as a quaternion `(w, x, y, z)`. */
export type EyeQuaternion = readonly [number, number, number, number];

/**
 * Gaze `[pitch_L, yaw_L, pitch_R, yaw_R]` (radians) -> both eye rotations, IN PLACE.
 *
 * The allocation-free form, for the per-frame path: `GnmRigBackend.encode` folds the
 * gaze into its params uniform every time the rig vector changes, and two fresh
 * four-element arrays per frame per character is exactly the kind of litter AGENTS
 * rule 2 is about.
 *
 * GNM composes `R = Rx(pitch) · Ry(yaw)` (`block.gaze_to_eye_rotations`), which as
 * quaternions is `q = qx(pitch) * qy(yaw)` in that order. Pitch > 0 looks DOWN and
 * yaw > 0 looks toward character-LEFT, both in the head-local canonical frame.
 * Getting the composition order backwards is a gaze that is right on each axis
 * alone and wrong on the diagonal, which is exactly the kind of thing that survives
 * a casual look.
 *
 * @param gaze Four radians: `[pitch_L, yaw_L, pitch_R, yaw_R]`.
 * @param out Eight doubles: the left rotation as `(w, x, y, z)`, then the right. Kept
 *   at double width so the reference and the shader see the same numbers the python
 *   oracle does — the params uniform narrows to f32 once, at the upload.
 * @returns The same `out`.
 */
export function gazeToEyeRotationsInto(gaze: ArrayLike<number>, out: Float64Array): Float64Array {
  for (let e = 0; e < 2; e++) {
    const hp = gaze[e * 2] * 0.5;
    const hy = gaze[e * 2 + 1] * 0.5;
    const cp = Math.cos(hp);
    const sp = Math.sin(hp);
    const cy = Math.cos(hy);
    const sy = Math.sin(hy);
    // qx(pitch) = (cp, sp, 0, 0); qy(yaw) = (cy, 0, sy, 0); Hamilton product in that
    // order. The Z term is `+sp*sy`: writing it negative composes `Ry·Rx` instead, which
    // is correct on each axis alone and wrong on the diagonal — measured, that cost
    // 0.85 mm against the python oracle while every single-axis check still passed.
    out[e * 4] = cp * cy;
    out[e * 4 + 1] = sp * cy;
    out[e * 4 + 2] = cp * sy;
    out[e * 4 + 3] = sp * sy;
  }
  return out;
}

/** Scratch for the tuple-returning {@link gazeToEyeRotations}, which is off the hot path. */
const gazeScratch = /* @__PURE__ */ new Float64Array(8);

/**
 * Gaze `[pitch_L, yaw_L, pitch_R, yaw_R]` (radians) -> a rotation per eye.
 *
 * The readable form, for tests and for the CPU reference. `gazeToEyeRotationsInto`
 * is the same maths without the two tuples, and is what the per-frame path calls.
 *
 * @param gaze Four radians: `[pitch_L, yaw_L, pitch_R, yaw_R]`.
 * @returns The left and right eye rotations, each `(w, x, y, z)`.
 */
export function gazeToEyeRotations(gaze: ArrayLike<number>): [EyeQuaternion, EyeQuaternion] {
  const q = gazeToEyeRotationsInto(gaze, gazeScratch);
  return [
    [q[0], q[1], q[2], q[3]],
    [q[4], q[5], q[6], q[7]],
  ];
}

/**
 * Rotate a vector by a quaternion `(w, x, y, z)`.
 *
 * @param q The rotation, assumed unit length.
 * @param x Vector x.
 * @param y Vector y.
 * @param z Vector z.
 * @returns The rotated vector as `[x, y, z]`.
 */
function quatRotate(q: EyeQuaternion, x: number, y: number, z: number): [number, number, number] {
  const [w, qx, qy, qz] = q;
  const cx = 2 * (qy * z - qz * y);
  const cy = 2 * (qz * x - qx * z);
  const cz = 2 * (qx * y - qy * x);
  return [
    x + w * cx + (qy * cz - qz * cy),
    y + w * cy + (qz * cx - qx * cz),
    z + w * cz + (qx * cy - qy * cx),
  ];
}

/**
 * Read one fp16 lane out of the packed basis array.
 *
 * @param basis The vertex-major basis, two fp16 halves per u32, low half first.
 * @param lane The half index — `(v * E + c) * 3 + axis`, not a word index.
 * @returns That lane's value, widened to a JS number.
 */
export function basisLane(basis: Uint32Array, lane: number): number {
  const word = basis[lane >>> 1];
  return halfToFloat((lane & 1) === 1 ? word >>> 16 : word & 0xffff);
}

/** What the reference produced. */
export interface GnmForwardResult {
  /** `(V,3)` head-local metres. */
  vertices: Float32Array;
}

/**
 * `head_ext` -> head-local vertices, BEFORE the seam stitch and before skinning.
 *
 * Reproduces `BakedHead.forward`: the linear expression model, then GNM's own eye
 * rotation blended by each eye joint's skinning weight.
 *
 * @param pack The parsed `.aosrig`, supplying the neutral, the basis and the eyes.
 * @param headExt One frame's packed rig vector — expression coefficients plus the
 *   four gaze angles, split by `unpackHeadExt`.
 * @returns The head-local vertices as `(V,3)` in METRES, before the seam stitch and
 *   before skinning.
 */
export function gnmForward(pack: AosRigPack, headExt: ArrayLike<number>): GnmForwardResult {
  const V = pack.vertexCount;
  const E = pack.coeffCount;
  const { expr, gaze } = unpackHeadExt(headExt, pack.header.headExt);

  const out = new Float32Array(V * 3);
  out.set(pack.neutral);

  // 1) neutral + Σ_c expr[c] · basis[v][c]. Vertex-major, so this walks the basis
  //    in memory order — the same order the shader's thread does.
  const scaled = new Float64Array(E);
  let anyCoeff = false;
  for (let c = 0; c < E; c++) {
    scaled[c] = expr[c] * pack.basisScale[c];
    if (scaled[c] !== 0) anyCoeff = true;
  }
  if (anyCoeff) {
    for (let v = 0; v < V; v++) {
      const row = v * E * 3;
      let dx = 0;
      let dy = 0;
      let dz = 0;
      for (let c = 0; c < E; c++) {
        const w = scaled[c];
        if (w === 0) continue;
        const o = row + c * 3;
        dx += w * basisLane(pack.basis, o);
        dy += w * basisLane(pack.basis, o + 1);
        dz += w * basisLane(pack.basis, o + 2);
      }
      out[v * 3] += dx;
      out[v * 3 + 1] += dy;
      out[v * 3 + 2] += dz;
    }
  }

  // 2) Gaze. Each eyeball rotates about its own joint and the displacement is
  //    blended by that joint's skinning weight — the model's own way of posing
  //    gaze, and the reason there is no eye bone in the body rig.
  const rotations = gazeToEyeRotations(gaze);
  for (let e = 0; e < 2; e++) {
    const q = rotations[e];
    if (q[1] === 0 && q[2] === 0 && q[3] === 0) continue; // identity
    const px = pack.eyePositions[e * 3];
    const py = pack.eyePositions[e * 3 + 1];
    const pz = pack.eyePositions[e * 3 + 2];
    const weights = pack.eyeWeights;
    const base = e * V;
    for (let v = 0; v < V; v++) {
      const w = weights[base + v];
      if (w === 0) continue;
      const o = v * 3;
      const rx = out[o] - px;
      const ry = out[o + 1] - py;
      const rz = out[o + 2] - pz;
      const [mx, my, mz] = quatRotate(q, rx, ry, rz);
      out[o] += w * (mx - rx);
      out[o + 1] += w * (my - ry);
      out[o + 2] += w * (mz - rz);
    }
  }

  return { vertices: out };
}

/**
 * The full rig -> vertices path on the CPU: `gnmForward`, the baked neck seam, then
 * linear-blend skinning against `jointWorld`.
 *
 * `jointWorld` is `J*16` row-major world matrices in the pack's compact joint
 * order, defaulting to the pack's own rest (which makes the skinning the identity).
 *
 * @param pack The parsed `.aosrig`.
 * @param headExt One frame's packed rig vector, as `gnmForward` takes it.
 * @param jointWorld `J*16` row-major world matrices in the pack's compact joint
 *   order. Defaults to `pack.restWorld`.
 * @returns The posed vertices as `(V,3)` in METRES, in the body's bind space —
 *   `bindTransform` is folded into the skin matrices rather than applied here.
 */
export function gnmPose(
  pack: AosRigPack,
  headExt: ArrayLike<number>,
  jointWorld: Float32Array = pack.restWorld,
): Float32Array {
  const V = pack.vertexCount;
  const maxInf = pack.maxInfluence;
  const { vertices } = gnmForward(pack, headExt);

  if (pack.stitchLocal) {
    for (let i = 0; i < vertices.length; i++) vertices[i] += pack.stitchLocal[i];
  }

  const skin = skinMatrices(pack, jointWorld);
  const out = new Float32Array(V * 3);
  for (let v = 0; v < V; v++) {
    const o = v * 3;
    const x = vertices[o];
    const y = vertices[o + 1];
    const z = vertices[o + 2];
    let ox = 0;
    let oy = 0;
    let oz = 0;
    const si = v * maxInf;
    for (let k = 0; k < maxInf; k++) {
      const w = pack.skinWeight[si + k];
      if (w === 0) continue;
      const b = pack.skinIndex[si + k] * 16;
      ox += w * (skin[b] * x + skin[b + 1] * y + skin[b + 2] * z + skin[b + 3]);
      oy += w * (skin[b + 4] * x + skin[b + 5] * y + skin[b + 6] * z + skin[b + 7]);
      oz += w * (skin[b + 8] * x + skin[b + 9] * y + skin[b + 10] * z + skin[b + 11]);
    }
    out[o] = ox;
    out[o + 1] = oy;
    out[o + 2] = oz;
  }
  return out;
}

/** Per-joint scratch for {@link skinMatrices}; J is a handful, and this runs per pose. */
const skinInvScratch = /* @__PURE__ */ new Float64Array(16);
const skinFoldScratch = /* @__PURE__ */ new Float64Array(16);

/**
 * `skin_j = world_j · inverse(rest_j) · bindTransform`, row-major, `J*16`.
 *
 * The pack stores rest world matrices rather than inverse binds because a rest is
 * inspectable — you can read a joint's position out of it — while an inverse bind
 * is not, and J is at most a handful so inverting at load costs nothing.
 *
 * `bindTransform` is folded in HERE, not applied to the vertices. `BakedHead.pose`
 * skins in the body's bind space, so head-local vertices must travel
 * `head_bind_world · local_to_head` first — but LBS is affine and comes after, so
 * `skin_j · (M · p)` is `(skin_j · M) · p`. Folding it costs J matrix products once
 * per pose change instead of V per frame, and it keeps the expression basis and the
 * gaze rotation in the head-local frame they are defined in.
 *
 * @param pack The parsed `.aosrig`, supplying `restWorld` and `bindTransform`.
 * @param jointWorld `J*16` row-major world matrices in the pack's compact joint
 *   order.
 * @param out Optional `J*16` destination, so the per-frame caller
 *   (`GnmRigBackend.refreshSkinRows`) allocates nothing. A short or absent one is
 *   replaced by a fresh array.
 * @returns `J*16` row-major skin matrices, bottom row left as `[0,0,0,1]`.
 * @throws {Error} When a joint's rest transform is singular and cannot be inverted.
 */
export function skinMatrices(
  pack: AosRigPack,
  jointWorld: Float32Array,
  out: Float32Array = new Float32Array(pack.header.joints.length * 16),
): Float32Array {
  const J = pack.header.joints.length;
  if (out.length < J * 16) out = new Float32Array(J * 16);
  const inv = skinInvScratch;
  const folded = skinFoldScratch;
  for (let j = 0; j < J; j++) {
    if (!invertAffine(pack.restWorld, j * 16, inv)) {
      throw new Error(
        `[aosrig] joint ${String(j)} ("${pack.header.joints[j].name}") has a singular rest transform`,
      );
    }
    const w = j * 16;
    for (let r = 0; r < 3; r++) {
      const a0 = jointWorld[w + r * 4];
      const a1 = jointWorld[w + r * 4 + 1];
      const a2 = jointWorld[w + r * 4 + 2];
      const a3 = jointWorld[w + r * 4 + 3];
      folded[r * 4] = a0 * inv[0] + a1 * inv[4] + a2 * inv[8] + a3 * inv[12];
      folded[r * 4 + 1] = a0 * inv[1] + a1 * inv[5] + a2 * inv[9] + a3 * inv[13];
      folded[r * 4 + 2] = a0 * inv[2] + a1 * inv[6] + a2 * inv[10] + a3 * inv[14];
      folded[r * 4 + 3] = a0 * inv[3] + a1 * inv[7] + a2 * inv[11] + a3 * inv[15];
    }
    const m = pack.bindTransform;
    for (let r = 0; r < 3; r++) {
      const a0 = folded[r * 4];
      const a1 = folded[r * 4 + 1];
      const a2 = folded[r * 4 + 2];
      const a3 = folded[r * 4 + 3];
      out[w + r * 4] = a0 * m[0] + a1 * m[4] + a2 * m[8] + a3 * m[12];
      out[w + r * 4 + 1] = a0 * m[1] + a1 * m[5] + a2 * m[9] + a3 * m[13];
      out[w + r * 4 + 2] = a0 * m[2] + a1 * m[6] + a2 * m[10] + a3 * m[14];
      out[w + r * 4 + 3] = a0 * m[3] + a1 * m[7] + a2 * m[11] + a3 * m[15];
    }
    out[w + 15] = 1;
  }
  return out;
}
