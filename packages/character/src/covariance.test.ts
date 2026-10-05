// The covariance the lift writes, against three's own writer.
//
// WHY THIS TEST EXISTS. `lift_pass2_cov.wgsl` recomposes the covariance as an
// OUTER-PRODUCT SUM over the scaled eigenvectors, while `GaussianSplatUtils`
// (three r186) composes `M = R(q)·diag(s)` and multiplies `M·Mᵀ`. They are the same
// quantity written two ways, and the reason for the rewrite is that the shader already
// HAS the eigenvectors — it just eigendecomposed pass 1's covariance — so building a
// rotation matrix from them only to multiply it out again is work for nothing.
//
// Getting the WRITE ORDER wrong is the failure with no symptom: the six terms are the
// upper triangle in `writeCovariance` order (c00, c01, c02, c11, c12, c22), split
// across two vec4 as `A = (c00, c01, c02, c11)` and `B = (c12, c22, 0, 0)`, and the
// vertex shader rebuilds `cov0 = (A.x, A.y, A.z)`, `cov1 = (A.y, A.w, B.x)`,
// `cov2 = (A.z, B.x, B.y)`. Any other order renders a plausible but wrong ellipsoid.
//
// Nothing here touches a GPU: this is the CPU reference the shader is written against,
// and `wgsl-syntax.test.ts` checks that the shader still spells the same six terms.

import { describe, expect, it } from 'vitest';

/**
 * A TS port of `GaussianSplatUtils.writeCovariance` (three r186), which is:
 *
 * ```js
 * _quaternion.set(qx, qy, qz, qw).normalize();
 * _rotationScaleMatrix.compose(_zero, _quaternion, _scale);   // M = R(q)·diag(s)
 * _covarianceMatrix.setFromMatrix4(_rotationScaleMatrix);
 * _covarianceMatrix.multiply(_covarianceMatrixTranspose);     // Σ = M·Mᵀ
 * target[offset + 0..5] = elements[0], [3], [6], [4], [7], [8];
 * ```
 *
 * three's `Matrix3.elements` is COLUMN-major, so `[0],[3],[6],[4],[7],[8]` are
 * `m11, m12, m13, m22, m23, m33` — the upper triangle, row by row.
 *
 * Written out longhand rather than imported so the test does not depend on three at
 * all: it is the contract that matters, and a port that drifts from the real thing is
 * caught by the numbers below being wrong.
 *
 * @param sx Gaussian scale along the local x axis, before rotation.
 * @param sy Gaussian scale along the local y axis, before rotation.
 * @param sz Gaussian scale along the local z axis, before rotation.
 * @param qx Rotation quaternion x, in three's `x, y, z, w` order; normalized here.
 * @param qy Rotation quaternion y.
 * @param qz Rotation quaternion z.
 * @param qw Rotation quaternion w.
 * @returns The six upper-triangle terms of `Σ = M·Mᵀ` in `writeCovariance` order:
 * `c00, c01, c02, c11, c12, c22`.
 */
function writeCovarianceReference(
  sx: number,
  sy: number,
  sz: number,
  qx: number,
  qy: number,
  qz: number,
  qw: number,
): number[] {
  const n = Math.hypot(qx, qy, qz, qw) || 1;
  const x = qx / n;
  const y = qy / n;
  const z = qz / n;
  const w = qw / n;
  // `Matrix4.compose` with a zero translation: the rotation's columns scaled.
  const x2 = x + x;
  const y2 = y + y;
  const z2 = z + z;
  const xx = x * x2;
  const xy = x * y2;
  const xz = x * z2;
  const yy = y * y2;
  const yz = y * z2;
  const zz = z * z2;
  const wx = w * x2;
  const wy = w * y2;
  const wz = w * z2;
  // M, row-major here for readability; columns are the scaled basis vectors.
  const m = [
    (1 - (yy + zz)) * sx,
    (xy - wz) * sy,
    (xz + wy) * sz,
    (xy + wz) * sx,
    (1 - (xx + zz)) * sy,
    (yz - wx) * sz,
    (xz - wy) * sx,
    (yz + wx) * sy,
    (1 - (xx + yy)) * sz,
  ];
  const dot = (r: number, c: number) =>
    m[r * 3] * m[c * 3] + m[r * 3 + 1] * m[c * 3 + 1] + m[r * 3 + 2] * m[c * 3 + 2];
  // Σ = M·Mᵀ, upper triangle in writeCovariance order.
  return [dot(0, 0), dot(0, 1), dot(0, 2), dot(1, 1), dot(1, 2), dot(2, 2)];
}

/**
 * What `lift_pass2_cov.wgsl` computes: the columns of `M` are the scaled eigenvectors,
 * and `Σ = M·Mᵀ = Σ_k s_k² (e_k ⊗ e_k)`.
 *
 * `e0`, `e1`, `e2` are the eigenvectors already scaled by their `sqrt(λ)` — exactly the
 * `e0`/`e1`/`e2` locals in the shader, including the `world_rotation` the shader applies
 * to each of them before the products.
 *
 * @param e0 First scaled eigenvector, as `(x, y, z)`.
 * @param e1 Second scaled eigenvector, as `(x, y, z)`.
 * @param e2 Third scaled eigenvector, as `(x, y, z)`.
 * @returns The same six terms in the same order as
 * {@link writeCovarianceReference}, so the two can be compared directly.
 */
function outerProductCovariance(
  e0: [number, number, number],
  e1: [number, number, number],
  e2: [number, number, number],
): number[] {
  const c = (a: 0 | 1 | 2, b: 0 | 1 | 2) => e0[a] * e0[b] + e1[a] * e1[b] + e2[a] * e2[b];
  return [c(0, 0), c(0, 1), c(0, 2), c(1, 1), c(1, 2), c(2, 2)];
}

/**
 * The quaternion's rotated, scaled basis — the shader's `e0`/`e1`/`e2`, built from a quat.
 *
 * @param sx Scale applied to the rotated x axis.
 * @param sy Scale applied to the rotated y axis.
 * @param sz Scale applied to the rotated z axis.
 * @param qx Rotation quaternion x, in `x, y, z, w` order; normalized here.
 * @param qy Rotation quaternion y.
 * @param qz Rotation quaternion z.
 * @param qw Rotation quaternion w.
 * @returns The three scaled axes, ready to feed {@link outerProductCovariance}.
 */
function scaledAxes(
  sx: number,
  sy: number,
  sz: number,
  qx: number,
  qy: number,
  qz: number,
  qw: number,
): [[number, number, number], [number, number, number], [number, number, number]] {
  const n = Math.hypot(qx, qy, qz, qw) || 1;
  const x = qx / n;
  const y = qy / n;
  const z = qz / n;
  const w = qw / n;
  const rotate = (vx: number, vy: number, vz: number): [number, number, number] => {
    const cx = 2 * (y * vz - z * vy);
    const cy = 2 * (z * vx - x * vz);
    const cz = 2 * (x * vy - y * vx);
    return [
      vx + w * cx + (y * cz - z * cy),
      vy + w * cy + (z * cx - x * cz),
      vz + w * cz + (x * cy - y * cx),
    ];
  };
  const a = rotate(1, 0, 0);
  const b = rotate(0, 1, 0);
  const c = rotate(0, 0, 1);
  return [
    [a[0] * sx, a[1] * sx, a[2] * sx],
    [b[0] * sy, b[1] * sy, b[2] * sy],
    [c[0] * sz, c[1] * sz, c[2] * sz],
  ];
}

/**
 * A deterministic PRNG, so a failure is reproducible.
 *
 * @param seed The starting state; the same seed always replays the same stream.
 * @returns A generator of values in `[0, 1)`, from a 32-bit linear congruential
 * sequence.
 */
function lcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

describe('covariance recomposition', () => {
  it('matches writeCovariance for the identity rotation', () => {
    const want = writeCovarianceReference(2, 3, 5, 0, 0, 0, 1);
    // Σ = diag(4, 9, 25): the off-diagonal terms must be exactly zero, which is what
    // catches a transposed or rotated write order on the simplest possible case.
    expect(want).toEqual([4, 0, 0, 9, 0, 25]);
    const got = outerProductCovariance(...scaledAxes(2, 3, 5, 0, 0, 0, 1));
    expect(got).toEqual(want);
  });

  it('matches writeCovariance over random poses', () => {
    const random = lcg(0x5eed);
    let worst = 0;
    for (let trial = 0; trial < 500; trial++) {
      const sx = 0.001 + random() * 2;
      const sy = 0.001 + random() * 2;
      const sz = 0.001 + random() * 2;
      const qx = random() * 2 - 1;
      const qy = random() * 2 - 1;
      const qz = random() * 2 - 1;
      const qw = random() * 2 - 1;
      const want = writeCovarianceReference(sx, sy, sz, qx, qy, qz, qw);
      const got = outerProductCovariance(...scaledAxes(sx, sy, sz, qx, qy, qz, qw));
      for (let i = 0; i < 6; i++) {
        const scale = Math.max(1e-6, Math.abs(want[i]));
        worst = Math.max(worst, Math.abs(got[i] - want[i]) / scale);
      }
    }
    // f64 throughout, so this is rounding only. The rendering spike measured 5.9e-8
    // through the real f32 shader.
    expect(worst).toBeLessThan(1e-12);
  });

  it('splits the six terms across the two vec4 the way the vertex shader reads them', () => {
    // A = (c00, c01, c02, c11); B = (c12, c22, 0, 0). The vertex shader rebuilds
    // cov0 = (A.x, A.y, A.z), cov1 = (A.y, A.w, B.x), cov2 = (A.z, B.x, B.y) — so the
    // matrix it reconstructs must be the symmetric one, entry for entry.
    const [c00, c01, c02, c11, c12, c22] = writeCovarianceReference(1, 2, 3, 0.2, 0.3, 0.4, 0.8);
    const A = [c00, c01, c02, c11];
    const B = [c12, c22, 0, 0];
    const cov0 = [A[0], A[1], A[2]];
    const cov1 = [A[1], A[3], B[0]];
    const cov2 = [A[2], B[0], B[1]];
    expect(cov0).toEqual([c00, c01, c02]);
    expect(cov1).toEqual([c01, c11, c12]);
    expect(cov2).toEqual([c02, c12, c22]);
    // Symmetric by construction, which is the invariant the packing exists to preserve.
    expect(cov0[1]).toBe(cov1[0]);
    expect(cov0[2]).toBe(cov2[0]);
    expect(cov1[2]).toBe(cov2[1]);
  });

  it('scales by the SQUARE of a world scale, because Σ is M·Mᵀ', () => {
    // The lift bakes the bundle's cm->m factor into the axes before the products, so a
    // 0.01 world scale shrinks the covariance by 1e-4 — not by 1e-2. Applying it once
    // would leave every splat 100x too large at exactly the scale nobody checks.
    const base = outerProductCovariance(...scaledAxes(1, 2, 3, 0.2, 0.3, 0.4, 0.8));
    const axes = scaledAxes(1, 2, 3, 0.2, 0.3, 0.4, 0.8).map((a) =>
      a.map((v) => v * 0.01),
    ) as Parameters<typeof outerProductCovariance>;
    const scaled = outerProductCovariance(...axes);
    for (let i = 0; i < 6; i++) expect(scaled[i]).toBeCloseTo(base[i] * 1e-4, 15);
  });

  it('packs a colour the way pack4x8unorm does', () => {
    // `pack4x8unorm(vec4f(r, g, b, a))` puts component 0 in the LOW byte:
    // r | g<<8 | b<<16 | a<<24. A byte-swapped write is a character with its red and
    // blue exchanged, which reads as a grading choice rather than as a bug.
    const pack = (r: number, g: number, b: number, a: number) =>
      (Math.round(Math.min(1, Math.max(0, r)) * 255) |
        (Math.round(Math.min(1, Math.max(0, g)) * 255) << 8) |
        (Math.round(Math.min(1, Math.max(0, b)) * 255) << 16) |
        (Math.round(Math.min(1, Math.max(0, a)) * 255) << 24)) >>>
      0;
    expect(pack(1, 0, 0, 0)).toBe(0x000000ff);
    expect(pack(0, 1, 0, 0)).toBe(0x0000ff00);
    expect(pack(0, 0, 1, 0)).toBe(0x00ff0000);
    expect(pack(0, 0, 0, 1)).toBe(0xff000000);
    // A culled texel writes opacity 0 and the slot stays allocated: constant capacity
    // is what keeps the sort's index -> splat map valid across frames.
    expect(pack(0, 0, 0, 0)).toBe(0);
  });

  it('turns an opacity LOGIT into a byte through a sigmoid', () => {
    // The decoder emits a logit, not a value. Writing it straight would clamp every
    // splat to fully opaque or fully transparent.
    const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));
    expect(Math.round(sigmoid(0) * 255)).toBe(128);
    expect(Math.round(sigmoid(-10) * 255)).toBe(0);
    expect(Math.round(sigmoid(10) * 255)).toBe(255);
  });
});
