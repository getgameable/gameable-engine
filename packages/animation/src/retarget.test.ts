import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  boneMapFromJson,
  hipHeightRatio,
  IDENTITY_QUAT,
  mapTrackName,
  quatInvert,
  quatMultiply,
  type Quat,
  rebindLocalRotation,
  rebindQuaternionTrack,
  type RestFrames,
  scalePositionTrack,
} from './retarget';

/**
 * A quaternion for a rotation about an axis.
 *
 * @param x Axis x.
 * @param y Axis y.
 * @param z Axis z.
 * @param angle Angle in radians.
 *
 * @returns The quaternion, xyzw.
 */
function axisAngle(x: number, y: number, z: number, angle: number): Quat {
  const h = angle / 2;
  const s = Math.sin(h);
  return [x * s, y * s, z * s, Math.cos(h)];
}

/**
 * Assert two quaternions are the same rotation, allowing the double cover.
 *
 * @param actual The computed quaternion.
 * @param expected The expected quaternion.
 */
function expectSameRotation(actual: ArrayLike<number>, expected: Quat): void {
  const dot =
    actual[0] * expected[0] +
    actual[1] * expected[1] +
    actual[2] * expected[2] +
    actual[3] * expected[3];
  expect(Math.abs(dot)).toBeCloseTo(1, 9);
}

describe('quaternion helpers', () => {
  it('multiplies and inverts', () => {
    const q = axisAngle(0, 1, 0, Math.PI / 3);
    const out: number[] = [0, 0, 0, 1];
    quatMultiply(q, quatInvert(q), out);
    expectSameRotation(out, IDENTITY_QUAT);
  });
});

describe('mapTrackName', () => {
  const map = new Map([
    ['mixamorig:Hips', 'pelvis'],
    ['mixamorig:LeftArm', 'upperarm_l'],
  ]);

  it('maps the node half and keeps the property', () => {
    expect(mapTrackName('mixamorig:Hips.quaternion', map)).toBe('pelvis.quaternion');
    expect(mapTrackName('mixamorig:Hips.position', map)).toBe('pelvis.position');
    expect(mapTrackName('mixamorig:LeftArm.quaternion', map)).toBe('upperarm_l.quaternion');
  });

  it('resolves a nested node path to its leaf', () => {
    expect(mapTrackName('Armature/mixamorig:Hips.quaternion', map)).toBe('pelvis.quaternion');
  });

  it('returns null for a bone with no target', () => {
    expect(mapTrackName('mixamorig:LeftHandPinky3.quaternion', map)).toBeNull();
  });

  it('handles a bare node name with no property', () => {
    expect(mapTrackName('mixamorig:Hips', map)).toBe('pelvis');
  });
});

describe('rebindLocalRotation', () => {
  const q = axisAngle(0, 1, 0, 0.4);
  const out: number[] = [0, 0, 0, 1];

  it('is a no-op when both skeletons share a rest pose', () => {
    const rest = axisAngle(1, 0, 0, 0.3);
    const parentRest = axisAngle(0, 0, 1, -0.2);
    const frames: RestFrames = {
      srcRest: rest,
      srcParentRest: parentRest,
      dstRest: rest,
      dstParentRest: parentRest,
    };
    rebindLocalRotation(q, frames, out);
    expectSameRotation(out, q);
  });

  it('maps a source pose AT REST onto the TARGET rest pose', () => {
    // This is the property that stops a retargeted clip injecting the source
    // rig's A-pose/T-pose difference as a constant offset into every frame.
    const frames: RestFrames = {
      srcRest: axisAngle(1, 0, 0, 0.6),
      srcParentRest: axisAngle(0, 1, 0, 0.25),
      dstRest: axisAngle(0, 0, 1, -0.45),
      dstParentRest: axisAngle(Math.SQRT1_2, Math.SQRT1_2, 0, 0.1),
    };
    // The source bone's rest in LOCAL space.
    const srcRestLocal: number[] = [0, 0, 0, 1];
    quatMultiply(quatInvert(frames.srcParentRest), frames.srcRest, srcRestLocal);
    // The target bone's rest in LOCAL space is what we must land on.
    const dstRestLocal: number[] = [0, 0, 0, 1];
    quatMultiply(quatInvert(frames.dstParentRest), frames.dstRest, dstRestLocal);

    rebindLocalRotation(srcRestLocal, frames, out);
    expectSameRotation(out, dstRestLocal);
  });
});

describe('rebindQuaternionTrack', () => {
  it('rewrites every key in place', () => {
    const frames: RestFrames = {
      srcRest: axisAngle(1, 0, 0, 0.6),
      srcParentRest: IDENTITY_QUAT,
      dstRest: IDENTITY_QUAT,
      dstParentRest: IDENTITY_QUAT,
    };
    const values = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1]);
    rebindQuaternionTrack(values, frames);
    // q * inv(srcRest) — the same for both keys, and not the identity.
    expect(values[0]).toBeCloseTo(values[4], 6);
    expect(Math.abs(values[3] - 1)).toBeGreaterThan(1e-3);
  });
});

describe('hip-height scaling', () => {
  it('scales the ratio of the two pelvis heights', () => {
    expect(hipHeightRatio(1.0, 0.9)).toBeCloseTo(0.9, 9);
  });

  it('falls back to 1 for a missing or zero height', () => {
    expect(hipHeightRatio(0, 0.9)).toBe(1);
    expect(hipHeightRatio(Number.NaN, 0.9)).toBe(1);
  });

  it('scales a position track in place', () => {
    const values = new Float32Array([0, 1, 0, 0, 2, 1]);
    scalePositionTrack(values, 0.5);
    expect([...values]).toEqual([0, 0.5, 0, 0, 1, 0.5]);
  });
});

describe('boneMapFromJson', () => {
  it('reads a flat source-to-target table and skips schema keys', () => {
    const map = boneMapFromJson({
      $schema: 'x',
      comment: 'doc',
      'mixamorig:Hips': 'pelvis',
    });
    expect(map.get('mixamorig:Hips')).toBe('pelvis');
    expect(map.has('comment')).toBe(false);
  });

  it('unwraps the shipped table’s `bones` field', () => {
    const map = boneMapFromJson({ comment: 'doc', targets: ['pelvis'], bones: { Hips: 'pelvis' } });
    expect(map.get('Hips')).toBe('pelvis');
    expect(map.size).toBe(1);
  });

  it('rejects a malformed table', () => {
    expect(() => boneMapFromJson(null)).toThrow(/expected an object/);
    expect(() => boneMapFromJson({ 'mixamorig:Hips': 3 })).toThrow(/must map to a target bone/);
  });
});

describe('assets/mixamo_to_mh.json', () => {
  const table: unknown = JSON.parse(
    readFileSync(fileURLToPath(new URL('../assets/mixamo_to_mh.json', import.meta.url)), 'utf8'),
  );
  const map = boneMapFromJson(table);

  /** The canonical MetaHuman body bones the retarget must be able to reach. */
  const CANONICAL = [
    'pelvis',
    'spine_01',
    'spine_02',
    'spine_03',
    'spine_04',
    'spine_05',
    'neck_01',
    'neck_02',
    'head',
    'clavicle_l',
    'upperarm_l',
    'lowerarm_l',
    'hand_l',
    'clavicle_r',
    'upperarm_r',
    'lowerarm_r',
    'hand_r',
    'thigh_l',
    'calf_l',
    'foot_l',
    'ball_l',
    'thigh_r',
    'calf_r',
    'foot_r',
    'ball_r',
  ];

  it('declares the canonical target list', () => {
    expect((table as { targets: string[] }).targets).toEqual(CANONICAL);
  });

  it('only ever maps onto canonical bone names', () => {
    for (const target of map.values()) expect(CANONICAL).toContain(target);
  });

  it('maps a Mixamo-lineage rig, prefixed or bare', () => {
    expect(map.get('mixamorig:Hips')).toBe('pelvis');
    expect(map.get('Hips')).toBe('pelvis');
    expect(map.get('LeftToeBase')).toBe('ball_l');
    expect(map.get('RightForeArm')).toBe('lowerarm_r');
  });

  it('routes the three-joint source spine onto 01 / 03 / 05', () => {
    // spine_02 and spine_04 have no source and stay at rest, interpolating the
    // chain rather than fighting it.
    expect(map.get('Spine')).toBe('spine_01');
    expect(map.get('Spine1')).toBe('spine_03');
    expect(map.get('Spine2')).toBe('spine_05');
    expect([...map.values()]).not.toContain(undefined);
  });

  it('is an identity map for a rig that is already canonical', () => {
    for (const bone of CANONICAL) expect(map.get(bone)).toBe(bone);
  });

  it('leaves fingers and twist joints unmapped', () => {
    expect(map.get('mixamorig:LeftHandIndex1')).toBeUndefined();
    expect(map.get('upperarm_twist_01_l')).toBeUndefined();
  });
});
