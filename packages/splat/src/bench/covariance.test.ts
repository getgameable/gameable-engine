/**
 * The covariance packing contract, ported from the spike's `check_cov.mjs`.
 *
 * A producer writes six floats per gaussian and three's vertex shader reads them back as a
 * symmetric 3x3. Getting the order wrong does not crash: it renders plausible-looking splats
 * with the wrong anisotropy, which is exactly the kind of bug that survives code review. So
 * the CPU twin of the animate shader's formulation is checked against
 * `GaussianSplatUtils.writeCovariance`, which is what every one of three's own loaders uses.
 *
 * The two computations are not the same algorithm: `writeCovariance` composes a `Matrix4` from
 * a quaternion and a scale and multiplies it by its own transpose, while the shader builds
 * Rodrigues rotation columns and accumulates `sum_k d_k * col_k (x) col_k`. Agreement to 1e-5
 * relative over random rotations and anisotropic scales is therefore evidence about the
 * ordering convention, not a tautology.
 */
import { writeCovariance } from 'three/addons/utils/GaussianSplatUtils.js';
import { describe, expect, it } from 'vitest';

import { covarianceFromAxisAngle } from './animateWgsl.js';
import { ANIMATE_WGSL } from './animateWgsl.js';

/** Deterministic LCG, so a failure is reproducible. */
function lcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

/** Unit quaternion `[x, y, z, w]` for an axis-angle rotation. */
function quaternionFromAxisAngle(
  axis: readonly [number, number, number],
  angle: number,
): [number, number, number, number] {
  const n = Math.hypot(axis[0], axis[1], axis[2]);
  const half = angle / 2;
  const s = Math.sin(half);
  return [(axis[0] / n) * s, (axis[1] / n) * s, (axis[2] / n) * s, Math.cos(half)];
}

describe('covariance packing', () => {
  it("matches three's writeCovariance over 200 random rotations and scales", () => {
    const random = lcg(0x2545f491);
    const mine = new Float64Array(6);
    const reference = new Float32Array(6);
    let worst = 0;

    for (let trial = 0; trial < 200; trial += 1) {
      const axis: [number, number, number] = [random() - 0.5, random() - 0.5, random() - 0.5];
      const angle = random() * Math.PI * 2;
      const scale: [number, number, number] = [
        0.01 + random() * 0.04,
        0.008 + random() * 0.01,
        0.008 + random() * 0.01,
      ];

      covarianceFromAxisAngle(mine, axis, angle, scale);

      const [qx, qy, qz, qw] = quaternionFromAxisAngle(axis, angle);
      writeCovariance(reference, 0, scale[0], scale[1], scale[2], qx, qy, qz, qw);

      for (let i = 0; i < 6; i += 1) {
        const delta = Math.abs(mine[i] - reference[i]);
        worst = Math.max(worst, delta / Math.max(1e-9, Math.abs(reference[i])));
      }
    }

    expect(worst).toBeLessThan(1e-5);
  });

  it('is symmetric, positive-definite and in c00 c01 c02 c11 c12 c22 order', () => {
    const out = new Float64Array(6);
    // Pure scale, no rotation: the covariance is diagonal with the squared scales on it, which
    // pins which of the six slots are the diagonal ones.
    covarianceFromAxisAngle(out, [0, 1, 0], 0, [0.02, 0.03, 0.05]);

    expect(out[0]).toBeCloseTo(0.02 * 0.02, 12); // c00
    expect(out[1]).toBeCloseTo(0, 12); // c01
    expect(out[2]).toBeCloseTo(0, 12); // c02
    expect(out[3]).toBeCloseTo(0.03 * 0.03, 12); // c11
    expect(out[4]).toBeCloseTo(0, 12); // c12
    expect(out[5]).toBeCloseTo(0.05 * 0.05, 12); // c22
  });

  it('a 90 degree turn about Y swaps the X and Z variances', () => {
    const out = new Float64Array(6);
    covarianceFromAxisAngle(out, [0, 1, 0], Math.PI / 2, [0.05, 0.01, 0.02]);
    expect(out[0]).toBeCloseTo(0.02 * 0.02, 10); // what was the Z extent is now along X
    expect(out[3]).toBeCloseTo(0.01 * 0.01, 10);
    expect(out[5]).toBeCloseTo(0.05 * 0.05, 10);
  });
});

describe('the animate shader', () => {
  it('writes the split the four storage buffers expect', () => {
    // covA is (c00, c01, c02, c11) and covB is (c12, c22, 0, 0): the 4/2 split of the six
    // upper-triangle floats that GaussianSplat.createStorageBuffers makes.
    expect(ANIMATE_WGSL).toContain('covA[i] = vec4<f32>(c00, c01, c02, c11);');
    expect(ANIMATE_WGSL).toContain('covB[i] = vec4<f32>(c12, c22, 0.0, 0.0);');
    // Colour is one u32 per splat, packed the way the TSL side unpacks it.
    expect(ANIMATE_WGSL).toContain('colors[i] = pack4x8unorm(');
    // Centres are vec4 with an unused w.
    expect(ANIMATE_WGSL).toContain('centers[i] = vec4<f32>(');
  });
});
