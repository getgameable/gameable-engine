import { describe, expect, it } from 'vitest';
import { Quaternion, Vector3 } from 'three/webgpu';
import {
  closePositionLoop,
  closeQuaternionLoop,
  selectGaitCycle,
  stationaryRootTrack,
} from './prepareLocomotion';

describe('offline locomotion preparation', () => {
  it('selects a same-foot cycle and scales playback to target speed', () => {
    const root: number[] = [],
      rotations: number[] = [];
    for (let i = 0; i < 12; i++) {
      root.push(0, 1, i / 10);
      new Quaternion()
        .setFromAxisAngle(new Vector3(1, 0, 0), Math.sin((i * Math.PI) / 2))
        .toArray(rotations, i * 4);
    }
    const take = { fps: 30, root, bones: { hip: rotations } };
    const options = {
      firstFrame: 0,
      lastFrame: 3,
      minimumPeriod: 3,
      maximumPeriod: 5,
      bones: ['hip'],
      hipRatio: 2,
      speed: 4,
    };
    const selected = selectGaitCycle(take, options);
    expect(selected.end - selected.start).toBe(4);
    expect(selected.score).toBeCloseTo(0);
    expect(selected.duration).toBeCloseTo(0.2);
    expect(() => selectGaitCycle(take, { ...options, minimumDuration: 10 })).toThrow('No steady');
    expect(() => selectGaitCycle(take, { ...options, lastFrame: 10 })).toThrow(RangeError);
    expect(() => selectGaitCycle({ ...take, bones: {} }, options)).toThrow(RangeError);
  });
  it('closes the seam without modifying the start or flattening the middle', () => {
    const rotations = new Float32Array(40);
    for (let i = 0; i < 10; i++)
      new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), i * 0.1).toArray(rotations, i * 4);
    const before = rotations.slice(0, 20);
    closeQuaternionLoop(rotations, 4);
    expect(rotations.slice(0, 20)).toEqual(before);
    expect(
      new Quaternion().fromArray(rotations).angleTo(new Quaternion().fromArray(rotations, 36)),
    ).toBeCloseTo(0);
    const signs = new Float32Array([0, 0, 0, 1, 0, 0, 0, -1]);
    closeQuaternionLoop(signs);
    expect(Math.abs(signs[7])).toBe(1);
    expect(() => {
      closeQuaternionLoop(new Float32Array(8));
    }).toThrow(RangeError);
  });
  it('keeps walking feet on the contact plane and retains running flight', () => {
    const floors = [0.1, 0.2, 0.15];
    const walk = stationaryRootTrack(floors, 0.9, { contactHeight: 0.045 });
    for (let i = 0; i < 3; i++) {
      expect(walk[i * 3]).toBe(0);
      expect(walk[i * 3 + 2]).toBe(0);
      expect(walk[i * 3 + 1] - 0.9 + floors[i]).toBeCloseTo(0.045);
    }
    const run = stationaryRootTrack(floors, 0.9, {
      sourceFloors: [0.1, 0.3, 0.1],
      hipRatio: 2,
      contactHeight: 0.045,
    });
    expect(run[4] - walk[4]).toBeCloseTo(0.4);
    closePositionLoop(run, 2);
    expect(run[7]).toBe(run[1]);
    expect(() => stationaryRootTrack([0, NaN], 1)).toThrow(RangeError);
    expect(() => {
      closePositionLoop(new Float32Array(4));
    }).toThrow(RangeError);
  });
});
