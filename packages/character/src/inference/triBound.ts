/**
 * Triangle-bounded splat clamp — the browser side of `utils/geom_reg.py`.
 *
 * WHY THIS FILE EXISTS. The clamp is applied at LIFT time, after the decoder,
 * so the exported ONNX graph does not carry it. A browser that lifts without it
 * paints splats the trained model never had — the same class of defect as the
 * lifter's face-validity threshold (see the "Lifter face validity has NO area
 * threshold — it must mirror training" note in the training repo's CLAUDE.md,
 * where a browser-only area gate manufactured a screen-sized halo).
 *
 * Shaders cannot import TS, so `wgsl/lift_pass1.wgsl` hand-inlines this; this
 * module is the single source of the CONSTANTS and the reference implementation
 * the shader is checked against. If you change the math here, change it there too
 * — a lifter that disagrees with its reference is worse than one that has no clamp
 * at all, because the disagreement is silent.
 *
 * Mirrors, function for function:
 *   triangleQuality  <-  utils.geom_reg.triangle_quality
 *   triangleBound    <-  utils.geom_reg.triangle_bound
 *   triScaleGain     <-  utils.geom_reg.tri_scale_gain
 *
 * Ported from aos-threejs-poc/src/ogs/inference/triBound.ts @ cdd63b10
 */

/**
 * sqrt(area) / longest_edge for an EQUILATERAL triangle: A = (sqrt(3)/4) L^2,
 *  so sqrt(A) = (3^(1/4)/2) L. Dividing by this re-expresses an area as "the
 *  edge of the equilateral triangle with that area", which is what makes the
 *  quality score 1 on a perfect face and ->0 on a sliver.
 */
export const EQUILATERAL_SQRT_AREA_PER_EDGE = Math.pow(3, 0.25) / 2; // 0.6580370064762462

/**
 * triangleBound derates linearly over [qMin, DERATE_RATIO * qMin]. Must equal
 *  utils.geom_reg._SLIVER_DERATE_RATIO.
 */
export const SLIVER_DERATE_RATIO = 5.0;

const EPS = 1e-12;

/**
 * Longest edge and area of the triangle whose first two Jacobian columns are
 *  `e0 = v1 - v0` and `e1 = v2 - v0`.
 *
 *  The Jacobian's columns 0 and 1 ARE those edge vectors
 *  (utils.graphics_utils.compute_face_Jacobian builds it that way), so both
 *  lifters can read the host triangle straight out of the matrix they already
 *  have — no extra upload, no extra texture. Column 2 is the normal and is NOT
 *  unit length (it is `n / sqrt(|n|)`), which is exactly why the area is taken
 *  from `cross(e0, e1)` here rather than from that column.
 *
 * @param e0x X of the first edge vector `e0 = v1 - v0`.
 * @param e0y Y of that edge.
 * @param e0z Z of that edge.
 * @param e1x X of the second edge vector `e1 = v2 - v0`.
 * @param e1y Y of that edge.
 * @param e1z Z of that edge.
 * @returns The longest of the triangle's three edge lengths and its area, both in whatever
 *   space the edge vectors were given in — world metres when they come from the Jacobian.
 */
export function triangleEdgeArea(
  e0x: number,
  e0y: number,
  e0z: number,
  e1x: number,
  e1y: number,
  e1z: number,
): { edge: number; area: number } {
  const l0 = Math.hypot(e0x, e0y, e0z);
  const l1 = Math.hypot(e1x, e1y, e1z);
  const l2 = Math.hypot(e1x - e0x, e1y - e0y, e1z - e0z);
  const cx = e0y * e1z - e0z * e1y;
  const cy = e0z * e1x - e0x * e1z;
  const cz = e0x * e1y - e0y * e1x;
  return { edge: Math.max(l0, Math.max(l1, l2)), area: 0.5 * Math.hypot(cx, cy, cz) };
}

/**
 * Shape quality in (0, 1]: 1 equilateral, ->0 sliver. Scale-invariant, so one
 *  threshold means the same thing on a 2 mm head face and a 9 mm garment one.
 *
 * @param edge The triangle's longest edge length, from {@link triangleEdgeArea}.
 * @param area The triangle's area, from the same call; negatives are floored at 0.
 * @returns The quality score, 1 for an equilateral face and approaching 0 for a sliver.
 */
export function triangleQuality(edge: number, area: number): number {
  const denom = Math.max(EQUILATERAL_SQRT_AREA_PER_EDGE * edge, EPS);
  return Math.min(1, Math.sqrt(Math.max(area, 0)) / denom);
}

/**
 * The length a splat on this face may not exceed, before kappa.
 *
 *  `qMin <= 0` disables the derate and returns the longest edge exactly, which
 *  is the whole mechanism's OFF state. Above the band the result is also
 *  exactly the longest edge — measured median derate 1.0000 on all four myra_v6
 *  branch meshes, i.e. this is inert on ordinary geometry by construction.
 *
 * @param edge The triangle's longest edge length, from {@link triangleEdgeArea}.
 * @param area The triangle's area, from the same call.
 * @param qMin The quality at the bottom of the derate band; 0 or less disables the derate.
 * @returns The longest edge, derated towards 0 as quality falls through the band.
 */
export function triangleBound(edge: number, area: number, qMin: number): number {
  if (!(qMin > 0)) return edge;
  const q = triangleQuality(edge, area);
  return edge * Math.min(1, q / (SLIVER_DERATE_RATIO * qMin));
}

/**
 * Multiplicative factor in (0, 1] forcing `maxWorldAxis <= kappa * bound`.
 *
 *  Exactly 1 — not approximately — on a compliant splat, so enabling the clamp
 *  cannot perturb geometry that already satisfies it. Callers apply it to the
 *  three columns of `M = J·R·diag(exp(s))`, whose norms ARE the world axis
 *  extents; scaling M by g scales the covariance M·Mᵀ by g².
 *
 * @param maxWorldAxis The largest column norm of `M = J·R·diag(exp(s))`, i.e. the splat's
 *   longest world-space extent.
 * @param bound The face's allowance, from {@link triangleBound}.
 * @param kappa How many times `bound` a splat may reach; 0 or less disables the clamp.
 * @returns The factor to scale `M`'s columns by — exactly 1 when the splat already complies.
 */
export function triScaleGain(maxWorldAxis: number, bound: number, kappa: number): number {
  if (!(kappa > 0)) return 1;
  return Math.min(1, (kappa * bound) / Math.max(maxWorldAxis, EPS));
}
