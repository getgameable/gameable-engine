// Per-pose rig→checkpoint anchoring: the drift a single neutral fit cannot carry.
//
// WHAT THIS FIXES. OGSBranch.calibrate() fits ONE similarity (scale+rotation+
// translation) plus a per-vertex `corr`, at the bundle's rest rig, and uses it at
// every pose thereafter. That is exact at the rest pose and only there. This
// repo's training geometry is baked as
//
//     gen_verts(t) = 100 · [ GlobalRigid(t) ∘ rig(rig_params(t)) ]
//
// where `GlobalRigid` is fitted PER FRAME onto the tracked wrap — and a MetaHuman
// face control set has no rigid head or neck pose controls (0 of eyeline-v10c's
// 168). So the rig can reproduce how the face DEFORMS but not where the head IS,
// and the frame it should be placed in genuinely differs pose to pose. aos-texavatars
// measured one fixed transform at 9-17 mm out at other poses and re-fits per pose
// (`ensureOrlCalibration`, web/src/main.ts) against that pose's own baked
// `frame_vertices`.
//
// WHY THIS IS NOT THAT, AND CANNOT BE. That re-fit needs baked ground-truth
// vertices for the pose being shown, which exist only for the ~246 TRAINED poses.
// aos-texavatars is a pose browser — you select trained pose N and it re-fits at N
// — while this repo drives a continuous rig synthesized from ARKit-52, for which
// no baked mesh exists at all. Re-fitting per frame is also not affordable: it is a
// GPU→CPU readback plus a Kabsch fit over 24k vertices plus a 288 KB upload.
//
// So the fit is moved OFFLINE (tools/bake_pose_anchors.mjs — aos-texavatars' own
// documented "Phase 5" shape). The baker fits every trained pose once and ships the
// 12 numbers per pose; at runtime the live rig is located among the trained poses
// and their anchors are BLENDED. ~12 KB, no readback, no per-frame decode.
//
// ONE BUNDLE-LEVEL DELTA, NOT ONE PER BRANCH. What varies per pose is
// `GlobalRigid(t)`, a single rigid transform of the WHOLE baked mesh, so every
// branch of a bundle must move by the same delta. Each entry here is therefore
// `D_N = A_0⁻¹ · A_N` in bundle space — fitted on the head branch, the only one
// with a vertex correspondence to fit against — and the runtime composes it onto
// whatever anchor each branch fitted for ITSELF at row 0. Two consequences, both
// load-bearing:
//   - the eyes/teeth shell branch needs no `adoptRigSpace` re-run. It borrows the
//     head's frame once at calibrate; moving both by one delta preserves their
//     relative placement exactly. Per-BRANCH deltas would not, and re-adopting per
//     frame allocates and re-runs joint assignment.
//   - a branch whose own anchor was refused stays refused. This only re-places a
//     fit that already passed; it can never resurrect one.
//
// WHAT IT DOES NOT DO. `corr` is NOT re-fitted — the neutral one is kept. That term
// is the rig-vs-WRAP shape gap (`neutral_vertices` is a tracked mesh the rig only
// approximates), which is a property of the two surfaces rather than of the pose;
// aos-texavatars re-fits it per pose only because it is already reading that pose's
// baked verts for the similarity, and it costs 288 KB per pose to ship. So this
// closes the rigid-placement half of the gap and leaves the shape half where it was.
//
// Pure: no WebGPU, no DOM, no generated shader imports, so the unit tests reach all
// of it — deliberate, because a wrong blend here moves the whole splat field with
// nothing to see but a face that is subtly in the wrong place.
//
// Ported from aos-threejs-poc/src/ogs/inference/poseAnchors.js @ cdd63b10. The
// `?poseanchor=1` URL gate is DROPPED — a game has no URL to carry flags in — and
// replaced by `CharacterOptions.poseAnchors`, which defaults OFF for the reason the
// POC's flag documents: a blink relocates the head by 5.1 mm in one frame, and a
// ~4.6 mm mean placement correction does not pay for a head pop synchronised with
// blinking.

/**
 * The bundle member this reads. Fixed name, not declared in scene.json: the
 *  file is written by our baker, not by the texavatars exporter, so there is no
 *  manifest field to carry it and a bundle simply has one or does not.
 */
export const POSE_ANCHORS_FILE = 'pose_anchors.json';

/**
 * Per-rig name, so a bundle can carry anchors for BOTH rigs at once.
 *
 *  The anchors are fitted per rig and the runtime refuses a mismatch, so a single
 *  `pose_anchors.json` lets a bundle serve only whichever rig it happened to be
 *  baked for — and `?rig=` can switch the live rig on any load. The unsuffixed name
 *  stays readable as a fallback for bundles baked before this.
 *
 * @param rig The rig the anchors were fitted for, e.g. `orl` or `rig2mesh`.
 * @returns The bundle member name to fetch for that rig.
 */
export const poseAnchorsFileFor = (rig: string): string => `pose_anchors_${rig}.json`;

export const POSE_ANCHORS_VERSION = 1;

/** Floats per baked entry: scale, quat xyzw, translation xyz. */
const STRIDE = 8;

/** A similarity in the row-vector convention `v' = v·lin + offset`. */
export interface Similarity {
  lin: Float32Array;
  offset: Float32Array;
}

/** A parsed `pose_anchors_<rig>.json`. */
export interface PoseAnchors {
  version: number;
  rig: string;
  referencePose: number;
  count: number;
  /** `count * 8`: scale, quat xyzw, translation xyz per trained pose. */
  entries: Float64Array;
  residual: { p50: number; p95: number } | null;
}

/** Below this the rig is ON a trained pose and that pose alone answers. */
const EXACT_EPS = 1e-6;

// ── similarity algebra ──────────────────────────────────────────────────────
//
// ROW-VECTOR throughout: `v' = v·M + o`, i.e. `out_j = Σ_i v_i · lin[i*3 + j]`.
// Same convention as OGSBranch.calibrate, vert_transform.wgsl and the training
// side's numpy `v @ lin`, so none of the four can disagree about a transpose.
// Getting it backwards transposes a small rotation, which looks like a slightly
// poor fit rather than like a bug.

/** Scratch for {@link composeSimilarity}, which runs on the per-frame path. */
const composeScratch = /* @__PURE__ */ new Float64Array(9);

/**
 * `base` then `delta`: v ↦ (v·B + oB)·D + oD.
 * Safe to alias `out*` with `base*` (reads finish before writes).
 *
 * @param bLin The base similarity's 9-float row-major linear part.
 * @param bOff The base similarity's 3-float translation.
 * @param dLin The delta similarity's linear part, applied after the base.
 * @param dOff The delta similarity's translation.
 * @param outLin Destination for the 9 composed linear floats; may alias `bLin`.
 * @param outOff Destination for the 3 composed translation floats; may alias `bOff`.
 * @returns The two destination buffers, wrapped as a `Similarity` for convenience.
 */
export function composeSimilarity(
  bLin: ArrayLike<number>,
  bOff: ArrayLike<number>,
  dLin: ArrayLike<number>,
  dOff: ArrayLike<number>,
  outLin: Float32Array,
  outOff: Float32Array,
): Similarity {
  // Module scratch, not a fresh array: this runs once per branch per full pass while
  // the baked anchors are on, and nine doubles per call is nine doubles of garbage.
  const m = composeScratch;
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      m[i * 3 + j] =
        bLin[i * 3] * dLin[j] + bLin[i * 3 + 1] * dLin[3 + j] + bLin[i * 3 + 2] * dLin[6 + j];
    }
  }
  const o0 = bOff[0] * dLin[0] + bOff[1] * dLin[3] + bOff[2] * dLin[6] + dOff[0];
  const o1 = bOff[0] * dLin[1] + bOff[1] * dLin[4] + bOff[2] * dLin[7] + dOff[1];
  const o2 = bOff[0] * dLin[2] + bOff[1] * dLin[5] + bOff[2] * dLin[8] + dOff[2];
  for (let k = 0; k < 9; k++) outLin[k] = m[k];
  outOff[0] = o0;
  outOff[1] = o1;
  outOff[2] = o2;
  return { lin: outLin, offset: outOff };
}

/**
 * Inverse of `v ↦ v·M + o`. Throws on a singular M — a similarity is never
 *  singular, so reaching this means the input was not one.
 *
 * @param lin The 9-float row-major linear part to invert.
 * @param off The 3-float translation.
 * @returns Freshly allocated `lin`/`offset` buffers for the inverse map.
 */
export function invertSimilarity(lin: ArrayLike<number>, off: ArrayLike<number>): Similarity {
  const a = lin;
  const c = new Float64Array(9);
  c[0] = a[4] * a[8] - a[5] * a[7];
  c[1] = a[2] * a[7] - a[1] * a[8];
  c[2] = a[1] * a[5] - a[2] * a[4];
  c[3] = a[5] * a[6] - a[3] * a[8];
  c[4] = a[0] * a[8] - a[2] * a[6];
  c[5] = a[2] * a[3] - a[0] * a[5];
  c[6] = a[3] * a[7] - a[4] * a[6];
  c[7] = a[1] * a[6] - a[0] * a[7];
  c[8] = a[0] * a[4] - a[1] * a[3];
  const det = a[0] * c[0] + a[1] * c[3] + a[2] * c[6];
  if (!Number.isFinite(det) || Math.abs(det) < 1e-30) {
    throw new Error('invertSimilarity: singular matrix — not a similarity');
  }
  const inv = new Float32Array(9);
  for (let k = 0; k < 9; k++) inv[k] = c[k] / det;
  const offset = new Float32Array([
    -(off[0] * inv[0] + off[1] * inv[3] + off[2] * inv[6]),
    -(off[0] * inv[1] + off[1] * inv[4] + off[2] * inv[7]),
    -(off[0] * inv[2] + off[1] * inv[5] + off[2] * inv[8]),
  ]);
  return { lin: inv, offset };
}

/**
 * Similarity → {scale, quaternion}. The BLENDABLE form: a similarity is
 * `s·R`, and averaging nine matrix entries does not stay a rotation while
 * averaging quaternions does.
 *
 * Throws on a reflection. `fitSimilarityRows` already refuses one, so a
 * reflection here means the delta was built from something that is not a pair
 * of similarities — and silently taking `|det|` would mirror the face.
 *
 * @param lin The 9-float row-major `s·R` to split.
 * @returns The uniform scale (the cube root of the determinant) and the rotation as a unit
 *   quaternion in xyzw order.
 */
export function decomposeSimilarity(lin: ArrayLike<number>): { scale: number; quat: Float64Array } {
  const det =
    lin[0] * (lin[4] * lin[8] - lin[5] * lin[7]) -
    lin[1] * (lin[3] * lin[8] - lin[5] * lin[6]) +
    lin[2] * (lin[3] * lin[7] - lin[4] * lin[6]);
  if (!(det > 0))
    throw new Error(
      `decomposeSimilarity: det ${String(det)} <= 0 — a reflection is not a similarity`,
    );
  const scale = Math.cbrt(det);
  const r = new Float64Array(9);
  for (let k = 0; k < 9; k++) r[k] = lin[k] / scale;
  return { scale, quat: quatFromRowMatrix(r) };
}

/**
 * {scale, quaternion} → similarity. Exact inverse of decomposeSimilarity.
 *
 * @param scale The uniform scale.
 * @param quat The rotation as a unit quaternion in xyzw order.
 * @param out A 9-float buffer to write into, so the blend allocates nothing per frame.
 * @returns `out`, holding the row-major `s·R`.
 */
export function recomposeSimilarity(
  scale: number,
  quat: ArrayLike<number>,
  out: Float32Array = new Float32Array(9),
): Float32Array {
  rowMatrixFromQuat(quat, out);
  for (let k = 0; k < 9; k++) out[k] *= scale;
  return out;
}

/**
 * Rotation (row-major, ROW-VECTOR convention) → quaternion [x,y,z,w].
 *
 * Reads the matrix TRANSPOSED, because the row-vector matrix is the transpose of
 * the column-vector rotation the standard branch-free construction is written
 * for. `rowMatrixFromQuat` transposes back, so the pair round-trips; the tests
 * pin that, which is what makes the convention safe to reason about locally.
 *
 * @param m The 9-float row-major rotation, in the row-vector convention.
 * @returns The equivalent unit quaternion as `[x, y, z, w]`.
 */
export function quatFromRowMatrix(m: ArrayLike<number>): Float64Array {
  // R[i][j] = m[j*3 + i]
  const r00 = m[0],
    r01 = m[3],
    r02 = m[6];
  const r10 = m[1],
    r11 = m[4],
    r12 = m[7];
  const r20 = m[2],
    r21 = m[5],
    r22 = m[8];
  const trace = r00 + r11 + r22;
  let x: number, y: number, z: number, w: number;
  if (trace > 0) {
    const s = 0.5 / Math.sqrt(trace + 1);
    w = 0.25 / s;
    x = (r21 - r12) * s;
    y = (r02 - r20) * s;
    z = (r10 - r01) * s;
  } else if (r00 > r11 && r00 > r22) {
    const s = 2 * Math.sqrt(1 + r00 - r11 - r22);
    w = (r21 - r12) / s;
    x = 0.25 * s;
    y = (r01 + r10) / s;
    z = (r02 + r20) / s;
  } else if (r11 > r22) {
    const s = 2 * Math.sqrt(1 + r11 - r00 - r22);
    w = (r02 - r20) / s;
    x = (r01 + r10) / s;
    y = 0.25 * s;
    z = (r12 + r21) / s;
  } else {
    const s = 2 * Math.sqrt(1 + r22 - r00 - r11);
    w = (r10 - r01) / s;
    x = (r02 + r20) / s;
    y = (r12 + r21) / s;
    z = 0.25 * s;
  }
  const n = Math.hypot(x, y, z, w) || 1;
  return new Float64Array([x / n, y / n, z / n, w / n]);
}

/**
 * Quaternion [x,y,z,w] → rotation, row-major, ROW-VECTOR convention.
 *
 * @param q The unit quaternion as `[x, y, z, w]`.
 * @param out A 9-float buffer to write into, so the blend allocates nothing per frame.
 * @returns `out`, holding the rotation row-major in the row-vector convention.
 */
export function rowMatrixFromQuat(
  q: ArrayLike<number>,
  out: Float32Array = new Float32Array(9),
): Float32Array {
  const x = q[0],
    y = q[1],
    z = q[2],
    w = q[3];
  const xx = x * x,
    yy = y * y,
    zz = z * z;
  const xy = x * y,
    xz = x * z,
    yz = y * z;
  const wx = w * x,
    wy = w * y,
    wz = w * z;
  // Column-vector R, written transposed (out[i*3+j] = R[j][i]).
  out[0] = 1 - 2 * (yy + zz);
  out[3] = 2 * (xy - wz);
  out[6] = 2 * (xz + wy);
  out[1] = 2 * (xy + wz);
  out[4] = 1 - 2 * (xx + zz);
  out[7] = 2 * (yz - wx);
  out[2] = 2 * (xz - wy);
  out[5] = 2 * (yz + wx);
  out[8] = 1 - 2 * (xx + yy);
  return out;
}

// ── the asset ───────────────────────────────────────────────────────────────

/**
 * Parse + VALIDATE a `pose_anchors.json`.
 *
 * Every check here is a way the file can be silently wrong for the bundle it was
 * dropped next to, and each one moves the whole splat field if it slips through:
 * anchors baked against a different rig, a different pose table, or a re-export
 * with a different pose count all produce plausible numbers pointing at the wrong
 * poses. Throwing means the character renders exactly as it did before the file
 * existed; accepting means it renders subtly displaced, everywhere, with nothing
 * to see. So this refuses rather than repairs, and the caller degrades to the
 * single neutral anchor and says why.
 *
 * @param json Parsed JSON.
 * @param expect What the live bundle actually resolved: the rig in use, and the pose
 *        table's shape.
 * @param expect.rig The rig id this load settled on; a file baked for another rig is refused.
 * @param expect.numPoses Rows in the bundle's pose-preset table; the anchor count must match
 *        exactly, since an entry's index IS its pose row.
 * @returns The validated anchors, with the per-pose scale/quat/translation flattened into
 *   `entries` at a stride of 8 and the quaternions renormalised.
 */
export function parsePoseAnchors(
  json: unknown,
  expect: { rig: string; numPoses: number },
): PoseAnchors {
  if (!json || typeof json !== 'object') throw new Error('pose anchors: not an object');
  const o = json as Record<string, unknown>;
  if (o.version !== POSE_ANCHORS_VERSION) {
    throw new Error(
      `pose anchors: version ${String(o.version)}, this build reads ${String(POSE_ANCHORS_VERSION)}`,
    );
  }
  // The rig is baked INTO the numbers: an exact-rig fit and a rig2mesh fit are
  // different transforms, and applying one to the other is a wrong face with no
  // error. `?rig=` can switch the live rig per load, so this is checked at use
  // time rather than assumed at bake time.
  if (typeof o.rig !== 'string' || !o.rig) throw new Error('pose anchors: no `rig`');
  if (o.rig !== expect.rig) {
    throw new Error(
      `pose anchors: baked for the '${o.rig}' rig, this load resolved '${expect.rig}' ` +
        '— re-bake, or drop the ?rig= override',
    );
  }
  // Parsed JSON: every entry is a claim, and each check below is a way the file can be
  // silently wrong for the bundle it was dropped next to.
  const anchors = o.anchors as (Partial<{ s: unknown; q: unknown; t: unknown }> | null)[];
  if (!Array.isArray(anchors) || !anchors.length) throw new Error('pose anchors: no `anchors`');
  // The entry index IS the pose-table row index — that is the only thing tying
  // an anchor to a rig vector. A table of a different length means the two are
  // not the same table, whatever the file says.
  if (anchors.length !== expect.numPoses) {
    throw new Error(
      `pose anchors: ${String(anchors.length)} entries but the bundle's pose table has ` +
        `${String(expect.numPoses)} rows — baked against a different export`,
    );
  }
  const ref = Number(o.reference_pose ?? 0);
  if (!Number.isInteger(ref) || ref < 0 || ref >= anchors.length) {
    throw new Error(
      `pose anchors: reference_pose ${String(o.reference_pose)} is not a row of the table`,
    );
  }
  const entries = new Float64Array(anchors.length * STRIDE);
  for (let i = 0; i < anchors.length; i++) {
    const a = anchors[i];
    if (!a || typeof a !== 'object')
      throw new Error(`pose anchors: entry ${String(i)} is not an object`);
    const s = Number(a.s);
    const q = a.q,
      t = a.t;
    if (!(s > 0) || !Number.isFinite(s))
      throw new Error(`pose anchors: entry ${String(i)} scale ${String(a.s)}`);
    if (!Array.isArray(q) || q.length !== 4)
      throw new Error(`pose anchors: entry ${String(i)} has no 4-element quaternion`);
    if (!Array.isArray(t) || t.length !== 3)
      throw new Error(`pose anchors: entry ${String(i)} has no 3-element translation`);
    const qn = Math.hypot(Number(q[0]), Number(q[1]), Number(q[2]), Number(q[3]));
    // A denormal quaternion silently scales the rotation into a shear once it is
    // recomposed, so it is refused rather than normalised: it means the file was
    // written by something other than the baker.
    if (!(Math.abs(qn - 1) < 1e-3)) {
      throw new Error(
        `pose anchors: entry ${String(i)} quaternion is not unit (|q| = ${qn.toFixed(6)})`,
      );
    }
    const b = i * STRIDE;
    entries[b] = s;
    for (let k = 0; k < 4; k++) entries[b + 1 + k] = Number(q[k]) / qn;
    for (let k = 0; k < 3; k++) {
      const v = Number(t[k]);
      if (!Number.isFinite(v))
        throw new Error(`pose anchors: entry ${String(i)} translation ${String(t[k])}`);
      entries[b + 5 + k] = v;
    }
  }
  const rawResidual = o.residual as { p50?: unknown; p95?: unknown } | undefined;
  const res =
    rawResidual && typeof rawResidual === 'object'
      ? { p50: Number(rawResidual.p50), p95: Number(rawResidual.p95) }
      : null;
  return {
    version: POSE_ANCHORS_VERSION,
    rig: o.rig,
    referencePose: ref,
    count: anchors.length,
    entries,
    residual: res,
  };
}

// ── the runtime blend ───────────────────────────────────────────────────────

/**
 * The live rig → a blended bundle-space delta.
 *
 * Locates the rig among the trained poses and blends their anchors. Blending, not
 * selecting: neighbouring poses' anchors differ by exactly the millimetres this
 * exists to correct, so switching between them would POP by the size of the fix —
 * visibly worse than the constant offset it replaces.
 *
 * The weights are Shepard with a CUTOFF at the (k+1)-th neighbour
 * (`w = 1/d - 1/d_cut`), not plain inverse distance. Plain weights are
 * discontinuous where the k-nearest SET changes — a pose entering the set does so
 * at nonzero weight, which is the same pop in a subtler place. With the cutoff
 * the entering and leaving members are at weight 0 exactly at the swap, so the
 * output is continuous across it.
 *
 * Allocation-free after construction, and it early-outs on an unchanged rig, so
 * it is safe on the per-frame path. Cost when it does run is one pass over the
 * pose table (246 x 168 for eyeline-v10c, ~40 us) plus a k-way blend.
 */
export interface PoseAnchorBlenderOptions {
  anchors: PoseAnchors;
  /** The bundle's rig-preset table, `presetRows * presetCols` floats. */
  presets: Float32Array;
  presetRows: number;
  presetCols: number;
  k?: number;
}

/** The live blend state: `lin`/`offset` are reused buffers, valid until the next update. */
export interface PoseAnchorBlender {
  readonly lin: Float32Array;
  readonly offset: Float32Array;
  readonly pose: number;
  readonly weights: { pose: number; w: number }[];
  update(rig: Float32Array): boolean;
}

/**
 * Build the blender described by {@link PoseAnchorBlenderOptions}.
 *
 * Everything the per-frame `update` touches is allocated here, so the returned object runs
 * without allocating. The two size checks are up front because a mismatched pose table and
 * anchor set would blend the right numbers onto the wrong poses, silently.
 *
 * @param options The baked anchors, the bundle's pose-preset table and the neighbourhood size.
 * @param options.anchors The parsed `pose_anchors_<rig>.json`.
 * @param options.presets The rig-preset table, `presetRows * presetCols` floats, row-major.
 * @param options.presetRows Rows in that table; must equal `anchors.count`.
 * @param options.presetCols Rig controls per row, which is also the length `update` expects.
 * @param options.k How many neighbours the blend keeps; clamped to `[1, presetRows]`, 4 by
 *   default. A (k+1)-th neighbour is located as well, to supply the Shepard cutoff.
 * @returns The blender: `lin` and `offset` hold the current bundle-space delta, `pose` and
 *   `weights` report how it was reached, and `update` recomputes them from a rig vector.
 */
export function createPoseAnchorBlender({
  anchors,
  presets,
  presetRows,
  presetCols,
  k = 4,
}: PoseAnchorBlenderOptions): PoseAnchorBlender {
  if (presetRows !== anchors.count) {
    throw new Error(
      `createPoseAnchorBlender: ${String(presetRows)} pose rows vs ${String(anchors.count)} anchors`,
    );
  }
  if (presets.length < presetRows * presetCols) {
    throw new Error(
      `createPoseAnchorBlender: pose table is ${String(presets.length)} floats, need ${String(presetRows * presetCols)}`,
    );
  }
  const K = Math.max(1, Math.min(k, presetRows));
  // K+1 slots: the extra one is the cutoff neighbour, which contributes the
  // threshold and never a weight.
  const bestIdx = new Int32Array(K + 1);
  const bestDist = new Float64Array(K + 1);
  const weight = new Float64Array(K);
  const quat = new Float64Array(4);
  const lin = new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1]);
  const offset = new Float32Array(3);
  const lastRig = new Float32Array(presetCols);
  let haveLast = false;
  let nearest = -1;

  const state = {
    lin,
    offset,
    /**
     * Row index of the closest trained pose — diagnostics only, never the blend.
     *
     * @returns That row index, or -1 before the first `update`.
     */
    get pose() {
      return nearest;
    },
    /**
     * The (index, weight) pairs that produced the current delta, NORMALISED —
     *  the same numbers the blend used, so a reader can reproduce it by hand.
     *
     * @returns One `{pose, w}` per contributing neighbour, weights summing to 1; empty
     *   before the first `update` and for a degenerate neighbourhood.
     */
    get weights() {
      let sum = 0;
      for (let i = 0; i < K; i++) if (weight[i] > 0) sum += weight[i];
      const out: { pose: number; w: number }[] = [];
      if (!(sum > 0)) return out;
      for (let i = 0; i < K; i++)
        if (weight[i] > 0) out.push({ pose: bestIdx[i], w: weight[i] / sum });
      return out;
    },
    update,
  };

  /**
   * True when `lin`/`offset` changed this call.
   *
   * @param rig The live rig vector, at least `presetCols` controls long.
   * @returns `false` when the rig matched the previous call to within 1e-6 per control and
   *   nothing was recomputed, `true` when the delta was rebuilt.
   */
  function update(rig: Float32Array): boolean {
    if (rig.length < presetCols) {
      throw new Error(
        `pose anchors: rig is ${String(rig.length)} controls, the pose table is ${String(presetCols)}`,
      );
    }
    if (haveLast) {
      let same = true;
      for (let i = 0; i < presetCols; i++) {
        if (Math.abs(rig[i] - lastRig[i]) > 1e-6) {
          same = false;
          break;
        }
      }
      if (same) return false;
    }
    for (let i = 0; i < presetCols; i++) lastRig[i] = rig[i];
    haveLast = true;

    // K+1 smallest by insertion — K is 4, so a partial selection beats a sort of
    // 246 and allocates nothing.
    const slots = K + 1;
    for (let i = 0; i < slots; i++) {
      bestIdx[i] = -1;
      bestDist[i] = Infinity;
    }
    for (let row = 0; row < presetRows; row++) {
      const base = row * presetCols;
      let d2 = 0;
      for (let i = 0; i < presetCols; i++) {
        const e = rig[i] - presets[base + i];
        d2 += e * e;
        // Every candidate is compared against the worst kept slot, so a far row
        // costs a few terms rather than the full 168.
        if (d2 >= bestDist[slots - 1]) break;
      }
      if (d2 >= bestDist[slots - 1]) continue;
      // SKIP A TIE. The pose table repeats itself — the canonicalisation gives
      // every frame of a cluster its medoid's rig vector, so eyeline-v10c's 246
      // rows hold ~89 distinct ones — and duplicates are exactly equidistant from
      // any query. Keeping them fills all K+1 slots with one position, which makes
      // the cutoff equal to every kept distance and drives every weight to zero:
      // the blend then degenerates to nearest-neighbour SELECTION, which is the
      // popping this exists to avoid. The baker gives every row of a duplicate
      // group the same (averaged) anchor, so dropping the repeats loses nothing.
      //
      // The test is SAME POSITION, not same distance. Equidistant-but-different is
      // the ordinary symmetric case — a query halfway between two poses is exactly
      // that — and dropping one of those pushes the blend onto the far side of the
      // neighbourhood it is supposed to sit inside. So a distance tie only triggers
      // the (rare) vector comparison that decides it.
      let duplicate = false;
      for (let j = 0; j < slots && !duplicate; j++) {
        if (bestIdx[j] < 0 || Math.abs(bestDist[j] - d2) > 1e-12 * (1 + d2)) continue;
        duplicate = true;
        const other = bestIdx[j] * presetCols;
        for (let i = 0; i < presetCols; i++) {
          if (presets[base + i] !== presets[other + i]) {
            duplicate = false;
            break;
          }
        }
      }
      if (duplicate) continue;
      let p = slots - 1;
      while (p > 0 && bestDist[p - 1] > d2) {
        bestDist[p] = bestDist[p - 1];
        bestIdx[p] = bestIdx[p - 1];
        p--;
      }
      bestDist[p] = d2;
      bestIdx[p] = row;
    }
    nearest = bestIdx[0];
    for (let i = 0; i < slots; i++) bestDist[i] = Math.sqrt(bestDist[i]);

    let sum = 0;
    if (bestDist[0] <= EXACT_EPS) {
      // ON a trained pose: that pose alone, exactly. Reproducing the baked anchor
      // bit for bit at the rows it was fitted at is what makes the blend testable.
      weight[0] = 1;
      sum = 1;
      for (let i = 1; i < K; i++) weight[i] = 0;
    } else {
      const cutoff = bestDist[K]; // Infinity when the table has <= K rows
      const invCut = Number.isFinite(cutoff) && cutoff > 0 ? 1 / cutoff : 0;
      for (let i = 0; i < K; i++) {
        const d = bestDist[i];
        const w = bestIdx[i] < 0 || !Number.isFinite(d) ? 0 : Math.max(0, 1 / d - invCut);
        weight[i] = w;
        sum += w;
      }
      if (!(sum > 0)) {
        // Every kept neighbour sits exactly at the cutoff (a degenerate table
        // where K+1 rows are equidistant). Fall back to the nearest rather than
        // dividing by zero — same answer the cutoff is converging to anyway.
        weight[0] = 1;
        sum = 1;
        for (let i = 1; i < K; i++) weight[i] = 0;
      }
    }

    // Blend: quaternions nlerp'd against the heaviest member's hemisphere (a
    // quaternion and its negation are the same rotation, and averaging across the
    // sign flip cancels toward zero), scale and translation lerp'd.
    let scale = 0,
      tx = 0,
      ty = 0,
      tz = 0;
    quat[0] = 0;
    quat[1] = 0;
    quat[2] = 0;
    quat[3] = 0;
    const refBase = bestIdx[0] * STRIDE;
    const e = anchors.entries;
    for (let i = 0; i < K; i++) {
      const w = weight[i] / sum;
      if (!(w > 0)) continue;
      const b = bestIdx[i] * STRIDE;
      const dot =
        e[b + 1] * e[refBase + 1] +
        e[b + 2] * e[refBase + 2] +
        e[b + 3] * e[refBase + 3] +
        e[b + 4] * e[refBase + 4];
      const sgn = dot < 0 ? -w : w;
      quat[0] += sgn * e[b + 1];
      quat[1] += sgn * e[b + 2];
      quat[2] += sgn * e[b + 3];
      quat[3] += sgn * e[b + 4];
      scale += w * e[b];
      tx += w * e[b + 5];
      ty += w * e[b + 6];
      tz += w * e[b + 7];
    }
    const qn = Math.hypot(quat[0], quat[1], quat[2], quat[3]);
    if (qn > 0) {
      quat[0] /= qn;
      quat[1] /= qn;
      quat[2] /= qn;
      quat[3] /= qn;
    } else {
      quat[3] = 1;
    }
    recomposeSimilarity(scale, quat, lin);
    offset[0] = tx;
    offset[1] = ty;
    offset[2] = tz;
    return true;
  }

  return state;
}
