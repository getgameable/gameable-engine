import { describe, expect, it } from 'vitest';

import {
  blendLocomotion,
  createLocomotionBlend,
  type LocomotionIndex,
  sortLocomotionClips,
  timeScaleFor,
  validateLocomotionIndex,
  writeLocomotionWeights,
} from './locomotion';

/** A three-clip blend space: idle, walk, run. */
const INDEX: LocomotionIndex = {
  clips: [
    { name: 'run', file: 'run.glb', loop: true, speed: 4 },
    { name: 'idle', file: 'idle.glb', loop: true, speed: 0 },
    { name: 'walk', file: 'walk.glb', loop: true, speed: 1.4 },
  ],
};

describe('sortLocomotionClips', () => {
  it('orders by authored speed and does not mutate the index', () => {
    const sorted = sortLocomotionClips(INDEX);
    expect(sorted.map((c) => c.name)).toEqual(['idle', 'walk', 'run']);
    expect(INDEX.clips[0].name).toBe('run');
  });
});

describe('blendLocomotion', () => {
  const sorted = sortLocomotionClips(INDEX);
  const out = createLocomotionBlend();

  it('clamps to idle at a standstill', () => {
    blendLocomotion(sorted, 0, out);
    expect(out.a).toBe('idle');
    expect(out.b).toBe('idle');
    expect(out.alpha).toBe(0);
    expect(out.timeScale).toBe(1);
  });

  it('brackets idle and walk at a slow speed', () => {
    blendLocomotion(sorted, 0.7, out);
    expect(out.a).toBe('idle');
    expect(out.b).toBe('walk');
    expect(out.alpha).toBeCloseTo(0.5, 6);
  });

  it('lands exactly on a clip at its authored speed', () => {
    blendLocomotion(sorted, 1.4, out);
    expect(out.alpha).toBeCloseTo(1, 6);
    expect(out.b).toBe('walk');
  });

  it('brackets walk and run in between', () => {
    blendLocomotion(sorted, 2.7, out);
    expect(out.a).toBe('walk');
    expect(out.b).toBe('run');
    expect(out.alpha).toBeCloseTo(0.5, 6);
  });

  it('clamps above the fastest clip and speeds its playback instead', () => {
    blendLocomotion(sorted, 6, out);
    expect(out.a).toBe('run');
    expect(out.b).toBe('run');
    expect(out.timeScale).toBeCloseTo(1.5, 6);
  });

  it('never stretches the stride past the usable range', () => {
    blendLocomotion(sorted, 100, out);
    expect(out.timeScale).toBe(2);
  });

  it('treats a negative speed as a standstill', () => {
    blendLocomotion(sorted, -3, out);
    expect(out.a).toBe('idle');
  });

  it('degrades to the single clip it has', () => {
    blendLocomotion(sortLocomotionClips({ clips: [INDEX.clips[0]] }), 2, out);
    expect(out.a).toBe('run');
    expect(out.b).toBe('run');
  });

  it('returns nothing for an empty blend space', () => {
    blendLocomotion([], 2, out);
    expect(out.a).toBeNull();
  });
});

describe('timeScaleFor', () => {
  it('is 1 for an in-place idle', () => {
    expect(timeScaleFor(3, 0)).toBe(1);
  });

  it('matches the stride to the ground speed', () => {
    expect(timeScaleFor(2.1, 1.4)).toBeCloseTo(1.5, 6);
  });

  it('clamps to [0.5, 2]', () => {
    expect(timeScaleFor(0.01, 1.4)).toBe(0.5);
    expect(timeScaleFor(14, 1.4)).toBe(2);
  });
});

describe('writeLocomotionWeights', () => {
  it('writes one weight for a clamped blend and two for a bracketed one', () => {
    const sorted = sortLocomotionClips(INDEX);
    const weights = new Map<string, number>();
    const speeds = new Map<string, number>();

    writeLocomotionWeights(blendLocomotion(sorted, 0, createLocomotionBlend()), weights, speeds);
    expect([...weights]).toEqual([['idle', 1]]);

    writeLocomotionWeights(blendLocomotion(sorted, 0.7, createLocomotionBlend()), weights, speeds);
    expect(weights.get('idle')).toBeCloseTo(0.5, 6);
    expect(weights.get('walk')).toBeCloseTo(0.5, 6);
    expect(speeds.get('walk')).toBe(1);
  });
});

describe('validateLocomotionIndex', () => {
  it('accepts a well-formed index and defaults loop to true', () => {
    const index = validateLocomotionIndex({
      clips: [{ name: 'idle', file: 'idle.glb', speed: 0 }],
    });
    expect(index.clips[0].loop).toBe(true);
  });

  it('rejects the shapes an offline tool can get wrong', () => {
    expect(() => validateLocomotionIndex(null)).toThrow(/expected an object/);
    expect(() => validateLocomotionIndex({})).toThrow(/must be an array/);
    expect(() => validateLocomotionIndex({ clips: [{ file: 'a.glb', speed: 0 }] })).toThrow(/name/);
    expect(() => validateLocomotionIndex({ clips: [{ name: 'a', speed: 0 }] })).toThrow(/file/);
    expect(() => validateLocomotionIndex({ clips: [{ name: 'a', file: 'a.glb' }] })).toThrow(
      /speed/,
    );
    expect(() =>
      validateLocomotionIndex({ clips: [{ name: 'a', file: 'a.glb', speed: -1 }] }),
    ).toThrow(/speed/);
  });
});
