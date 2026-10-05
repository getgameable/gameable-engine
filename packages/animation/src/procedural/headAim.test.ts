// Ported from aos-threejs-poc/tests/unit/headAim.test.mjs @ cdd63b10
import { describe, expect, it } from 'vitest';

import { approachAngle, clampPitch, clampYawToBody, normalizeAngle } from './headAim';

/** One degree in radians. */
const D = Math.PI / 180;

describe('normalizeAngle', () => {
  it('wraps into (-pi, pi]', () => {
    expect(normalizeAngle(0)).toBeCloseTo(0, 12);
    expect(normalizeAngle(Math.PI)).toBeCloseTo(Math.PI, 12);
    expect(normalizeAngle(Math.PI + 0.1)).toBeCloseTo(-Math.PI + 0.1, 12);
    expect(normalizeAngle(3 * Math.PI)).toBeCloseTo(Math.PI, 12);
    expect(normalizeAngle(-3 * Math.PI)).toBeCloseTo(Math.PI, 12);
  });
});

describe('clampYawToBody', () => {
  it('behaves like the old world clamp while the body faces +Z', () => {
    const maxYaw = 45 * D;
    expect(clampYawToBody(0, 0, maxYaw)).toBeCloseTo(0, 12);
    expect(clampYawToBody(30 * D, 0, maxYaw)).toBeCloseTo(30 * D, 12);
    expect(clampYawToBody(70 * D, 0, maxYaw)).toBeCloseTo(45 * D, 12);
  });

  it('keeps the head within maxYaw of a yawed torso (the exorcist bug)', () => {
    const maxYaw = 45 * D;
    // The body has turned 90 degrees to walk; the camera is still near world +Z.
    // A world-anchored clamp would leave the head 90 degrees off the torso.
    const rel = clampYawToBody(0, 90 * D, maxYaw);
    expect(rel).toBeCloseTo(-45 * D, 12);
    expect(Math.abs(rel)).toBeLessThanOrEqual(maxYaw + 1e-9);
  });

  it('never exceeds maxYaw for any body and camera angle', () => {
    const maxYaw = 45 * D;
    for (let body = -180; body <= 180; body += 15) {
      for (let cam = -180; cam <= 180; cam += 15) {
        const rel = clampYawToBody(cam * D, body * D, maxYaw);
        expect(Math.abs(rel)).toBeLessThanOrEqual(maxYaw + 1e-9);
      }
    }
  });

  it('turns the head toward the camera, not away', () => {
    const maxYaw = 45 * D;
    expect(clampYawToBody(20 * D, 0, maxYaw)).toBeCloseTo(20 * D, 12);
    expect(clampYawToBody(20 * D, 20 * D, maxYaw)).toBeCloseTo(0, 12);
  });
});

describe('clampPitch', () => {
  it('clamps symmetrically after wrapping', () => {
    expect(clampPitch(10 * D, 25 * D)).toBeCloseTo(10 * D, 12);
    expect(clampPitch(70 * D, 25 * D)).toBeCloseTo(25 * D, 12);
    expect(clampPitch(-70 * D, 25 * D)).toBeCloseTo(-25 * D, 12);
  });
});

describe('approachAngle', () => {
  it('is framerate-corrected: one 1/30 s step equals two 1/60 s steps', () => {
    const target = 1;
    const twoSmall = approachAngle(approachAngle(0, target, 8, 1 / 60), target, 8, 1 / 60);
    const oneBig = approachAngle(0, target, 8, 2 / 60);
    expect(Math.abs(twoSmall - oneBig)).toBeLessThan(1e-12);
  });

  it('takes the short way round instead of unwinding', () => {
    // 170 degrees to -170 degrees is a 20 degree step, not a 340 degree one.
    const next = approachAngle(170 * D, -170 * D, 8, 1 / 60);
    expect(next).toBeGreaterThan(170 * D);
  });

  it('is a no-op at dt 0, and does not divide by zero', () => {
    expect(approachAngle(0.5, 1, 8, 0)).toBeCloseTo(0.5, 12);
  });
});
