// The rig -> checkpoint anchoring: a similarity fit plus a per-vertex correction.
//
// TWO TERMS, and neither substitutes for the other.
//
// The SIMILARITY is the change of FRAME. A rig backend emits its own world space
// while the training export bakes `100 · [GlobalRigid(t) ∘ rig(rig_params(t))]`, and
// on one shipped character that rotation lived inside the distilled ONNX as `100·R0`
// (measured 3.45°). Left out, every DISPLACEMENT is rotated wrong by ~6% of its
// magnitude while the neutral still looks perfect — the per-vertex term hides it at
// exactly the pose you check.
//
// The PER-VERTEX `corr` is the rig-vs-WRAP shape gap: `neutral_vertices` is a
// TRACKED mesh the rig only approximates (0.265 cm mean on one character), which no
// rigid transform reaches. Without it the browser renders the rig's surface rather
// than the one the decoders were trained on.
//
// Both fold into the lift's ONE vert-transform pass:
// `v' = v·M + offset + corr[i]`.
//
// Ported from aos-threejs-poc/src/ogs/graph/nodes/OGSBranch.ts @ cdd63b10
// (`fitSimilarityRows`, `meanRadius` and the residual verdict).

/** A similarity in the row-vector convention `v' = v·lin + offset`. */
export interface SimilarityFit {
  lin: Float32Array;
  offset: Float32Array;
}

/**
 * Best-fit similarity (uniform scale + proper rotation + translation) taking `src`
 * onto `dst`, returned ROW-major for the `v·M + offset` convention the WGSL pass and
 * the offline tooling both use.
 *
 * Kabsch, via the 3x3 cross-covariance — small enough to solve here rather than pull
 * in a matrix library. A reflection is EXCLUDED (the det check): a mirrored head is a
 * broken asset, not a coordinate convention.
 *
 * SAME DECOMPOSITION as the offline `calibrate()`, NOT the same solver: that one has
 * numpy and calls `np.linalg.svd`, taking the scale from the singular values; this
 * takes the rotation from the polar iteration below and the scale from
 * `trace(RᵀH)/Σ|a|²`, which is the same quantity written without an SVD. They agree
 * by construction rather than by test, so do not "simplify" either into a different
 * fit. What is genuinely shared is the part that matters operationally: both refuse a
 * reflection, and both refuse a residual too large to be the rig-vs-wrap gap.
 *
 * Eigen-decomposition of a symmetric 3x3 is avoided by taking the rotation from a few
 * Newton iterations on the polar decomposition (`M -> (M + M⁻ᵀ)/2`), which converges
 * in ~5 steps for the near-rigid matrices this ever sees.
 *
 * @param src The source point set as flat xyz triples — the rig's predicted vertices.
 * @param dst The target point set, same length and same vertex ORDER — the bundle's neutral.
 * @returns The fit: `lin` is the 9-float row-major `scale * rotation`, `offset` the 3-float
 *   translation, together giving `dst ~= src * lin + offset`.
 */
export function fitSimilarityRows(src: Float32Array, dst: Float32Array): SimilarityFit {
  const n = src.length / 3;
  const cs = [0, 0, 0];
  const cd = [0, 0, 0];
  for (let i = 0; i < src.length; i += 3) {
    cs[0] += src[i];
    cs[1] += src[i + 1];
    cs[2] += src[i + 2];
    cd[0] += dst[i];
    cd[1] += dst[i + 1];
    cd[2] += dst[i + 2];
  }
  for (let k = 0; k < 3; k++) {
    cs[k] /= n;
    cd[k] /= n;
  }

  // H = Σ aᵀb (a, b centred), and Σ|a|² for the scale.
  const H = new Float64Array(9);
  let aa = 0;
  for (let i = 0; i < src.length; i += 3) {
    const ax = src[i] - cs[0];
    const ay = src[i + 1] - cs[1];
    const az = src[i + 2] - cs[2];
    const bx = dst[i] - cd[0];
    const by = dst[i + 1] - cd[1];
    const bz = dst[i + 2] - cd[2];
    H[0] += ax * bx;
    H[1] += ax * by;
    H[2] += ax * bz;
    H[3] += ay * bx;
    H[4] += ay * by;
    H[5] += ay * bz;
    H[6] += az * bx;
    H[7] += az * by;
    H[8] += az * bz;
    aa += ax * ax + ay * ay + az * az;
  }

  // Polar decomposition of H: iterate R <- (R + R⁻ᵀ)/2 until orthogonal.
  //
  // A SINGULAR H means the points span fewer than three dimensions (all equal,
  // collinear, coplanar) and no rotation is determined by them. Fall back to the
  // identity rather than iterating on a degenerate matrix: the fit degrades to scale
  // + translation, which is the most those points can support. Real head meshes never
  // hit this; the neutral-vs-neutral fixtures in the unit tests do.
  let R = Float64Array.from(H);
  if (!invert3(R)) R = Float64Array.from([1, 0, 0, 0, 1, 0, 0, 0, 1]);
  for (let it = 0; it < 24; it++) {
    const inv = invert3(R);
    if (!inv) break;
    let delta = 0;
    for (let k = 0; k < 9; k++) {
      // transpose of the inverse, i.e. inv[col][row]
      const t = inv[(k % 3) * 3 + ((k / 3) | 0)];
      const next = 0.5 * (R[k] + t);
      delta += Math.abs(next - R[k]);
      R[k] = next;
    }
    if (delta < 1e-12) break;
  }
  // A reflection is REFUSED, not repaired. Kabsch's usual fix (negate the smallest
  // singular direction) needs the SVD this polar iteration avoids, and negating the
  // whole matrix would drive the fitted SCALE negative instead — silently mirroring
  // the face. det < 0 means the neutral genuinely does not correspond to the rig's (a
  // mirrored or mis-ordered mesh), which is a broken asset rather than a coordinate
  // convention, so say so.
  if (det3(R) < 0) {
    throw new Error(
      "rig->checkpoint calibration: the bundle's neutral is a REFLECTION of the rig's, " +
        'which no rotation can reach — a mirrored or vertex-reordered mesh.',
    );
  }

  // Uniform scale that best matches |a| to |b| under R: trace(Rᵀ H) / Σ|a|².
  let num = 0;
  for (let k = 0; k < 9; k++) num += R[k] * H[k];
  const scale = aa > 0 ? num / aa : 1;

  const lin = new Float32Array(9);
  for (let k = 0; k < 9; k++) lin[k] = scale * R[k];
  const offset = new Float32Array([
    cd[0] - (cs[0] * lin[0] + cs[1] * lin[3] + cs[2] * lin[6]),
    cd[1] - (cs[0] * lin[1] + cs[1] * lin[4] + cs[2] * lin[7]),
    cd[2] - (cs[0] * lin[2] + cs[1] * lin[5] + cs[2] * lin[8]),
  ]);
  return { lin, offset };
}

/**
 * Mean distance of a point set from its own centroid — the scale a residual is judged
 * against, so the tolerance means the same thing on a head as on a decimated eye shell.
 *
 * @param p The point set as flat xyz triples.
 * @returns The mean distance from the centroid, in the point set's own units; 0 for an empty
 *   set.
 */
export function meanRadius(p: Float32Array): number {
  const n = p.length / 3;
  if (!n) return 0;
  let cx = 0;
  let cy = 0;
  let cz = 0;
  for (let i = 0; i < p.length; i += 3) {
    cx += p[i];
    cy += p[i + 1];
    cz += p[i + 2];
  }
  cx /= n;
  cy /= n;
  cz /= n;
  let sum = 0;
  for (let i = 0; i < p.length; i += 3) {
    sum += Math.hypot(p[i] - cx, p[i + 1] - cy, p[i + 2] - cz);
  }
  return sum / n;
}

/** What a calibration produced. */
export interface Calibration extends SimilarityFit {
  /** `V*3` per-vertex correction: `neutral - M·pred`. */
  corr: Float32Array;
  /** Mean per-vertex residual, in the BUNDLE's units. */
  residual: number;
  /** `0.05 * meanRadius(neutral)` — what `residual` is judged against. */
  tolerance: number;
}

/**
 * Fit the rig -> bundle similarity and the per-vertex correction.
 *
 * JUDGE THE RESIDUAL BEFORE CANCELLING IT. `corr` absorbs anything at the anchor pose
 * — including the wrong DNA, or the right vertex count in a different ORDER — so an
 * unchecked fit renders a perfect neutral face with every expression driven by a rig
 * that is not this mesh's. The threshold is a FRACTION of the mesh's own radius, not
 * an absolute, because some residual is legitimate (the tracked-wrap gap above); a
 * vertex-order mismatch lands near 100% of that radius, so 5% catches it with room to
 * spare. Same test and tolerance as the offline calibration, so the two halves agree
 * on what they REFUSE and not just on the maths they run.
 *
 * @param pred The rig's vertices at the anchor pose, flat xyz triples in rig space.
 * @param neutral The bundle's `neutral_vertices`, flat xyz triples in the checkpoint's space,
 *   same length and same vertex order as `pred`.
 * @returns The similarity, the per-vertex `corr` residual, and the `residual`/`tolerance` pair
 *   the caller is expected to compare before trusting the fit.
 */
export function calibrate(pred: Float32Array, neutral: Float32Array): Calibration {
  if (pred.length !== neutral.length) {
    throw new Error(
      `calibrate: rig produced ${String(pred.length / 3)} vertices, the mesh has ${String(neutral.length / 3)}`,
    );
  }
  const { lin, offset } = fitSimilarityRows(pred, neutral);
  const corr = new Float32Array(pred.length);
  let residSum = 0;
  for (let i = 0; i < corr.length; i += 3) {
    const x = pred[i];
    const y = pred[i + 1];
    const z = pred[i + 2];
    corr[i] = neutral[i] - (x * lin[0] + y * lin[3] + z * lin[6] + offset[0]);
    corr[i + 1] = neutral[i + 1] - (x * lin[1] + y * lin[4] + z * lin[7] + offset[1]);
    corr[i + 2] = neutral[i + 2] - (x * lin[2] + y * lin[5] + z * lin[8] + offset[2]);
    residSum += Math.hypot(corr[i], corr[i + 1], corr[i + 2]);
  }
  return {
    lin,
    offset,
    corr,
    residual: residSum / (pred.length / 3),
    tolerance: 0.05 * meanRadius(neutral),
  };
}

/**
 * Determinant of a flat 3x3.
 *
 * @param m The 9 values, row-major.
 * @returns The determinant; a negative value means the matrix includes a reflection.
 */
export function det3(m: ArrayLike<number>): number {
  return (
    m[0] * (m[4] * m[8] - m[5] * m[7]) -
    m[1] * (m[3] * m[8] - m[5] * m[6]) +
    m[2] * (m[3] * m[7] - m[4] * m[6])
  );
}

/**
 * Inverse of a flat 3x3, or null when singular.
 *
 * @param m The 9 values, row-major.
 * @returns A new row-major `Float64Array` holding the inverse, or `null` when the determinant
 *   is non-finite or below 1e-30 — which is how the polar iteration detects a degenerate fit.
 */
export function invert3(m: ArrayLike<number>): Float64Array | null {
  const d = det3(m);
  if (!isFinite(d) || Math.abs(d) < 1e-30) return null;
  const o = new Float64Array(9);
  o[0] = (m[4] * m[8] - m[5] * m[7]) / d;
  o[1] = (m[2] * m[7] - m[1] * m[8]) / d;
  o[2] = (m[1] * m[5] - m[2] * m[4]) / d;
  o[3] = (m[5] * m[6] - m[3] * m[8]) / d;
  o[4] = (m[0] * m[8] - m[2] * m[6]) / d;
  o[5] = (m[2] * m[3] - m[0] * m[5]) / d;
  o[6] = (m[3] * m[7] - m[4] * m[6]) / d;
  o[7] = (m[1] * m[6] - m[0] * m[7]) / d;
  o[8] = (m[0] * m[4] - m[1] * m[3]) / d;
  return o;
}
