// Ported from the additive-bake coverage in aos-threejs-poc @ cdd63b10
import {
  AnimationClip,
  Bone,
  Object3D,
  Quaternion,
  QuaternionKeyframeTrack,
  Vector3,
} from 'three/webgpu';
import { describe, expect, it } from 'vitest';

import {
  bakeAdditive,
  buildBoneParents,
  buildRestPose,
  resolveAdditiveSettings,
} from './additiveBake';

/**
 * root -> Armature -> pelvis -> spine_01.
 *
 * @returns The rig root.
 */
function makeRig(): Object3D {
  const root = new Object3D();
  const armature = new Object3D();
  armature.name = 'Armature';
  const pelvis = new Bone();
  pelvis.name = 'pelvis';
  pelvis.position.set(0, 1, 0);
  const spine = new Bone();
  spine.name = 'spine_01';
  spine.position.set(0, 0.2, 0);
  root.add(armature);
  armature.add(pelvis);
  pelvis.add(spine);
  return root;
}

/**
 * A two-frame identity-rotation clip on spine_01.
 *
 * @returns The clip.
 */
function identityClip(): AnimationClip {
  return new AnimationClip('g', 2 / 30, [
    new QuaternionKeyframeTrack('spine_01.quaternion', [0, 1 / 30], [0, 0, 0, 1, 0, 0, 0, 1]),
  ]);
}

describe('resolveAdditiveSettings', () => {
  it('falls back to local space against the clip’s own frame 0', () => {
    expect(resolveAdditiveSettings(null)).toEqual({
      additiveType: 'local',
      basePoseType: 'local_frame',
      basePoseClipName: null,
      refFrameIndex: 0,
    });
  });

  it('treats an explicit "none" as "not configured"', () => {
    const r = resolveAdditiveSettings({ additiveType: 'none', basePoseType: 'none' });
    expect(r.additiveType).toBe('local');
    expect(r.basePoseType).toBe('local_frame');
  });

  it('keeps an explicit configuration', () => {
    const r = resolveAdditiveSettings({
      additiveType: 'mesh',
      basePoseType: 'anim_frame',
      basePoseClipName: 'base',
      refFrameIndex: 7,
    });
    expect(r).toEqual({
      additiveType: 'mesh',
      basePoseType: 'anim_frame',
      basePoseClipName: 'base',
      refFrameIndex: 7,
    });
  });
});

describe('bakeAdditive', () => {
  it('ref_pose against an identity rest leaves an identity delta', () => {
    const rig = makeRig();
    const clip = identityClip();
    bakeAdditive(
      clip,
      { additiveType: 'local', basePoseType: 'ref_pose' },
      {
        clipsByName: new Map(),
        restPose: buildRestPose(rig),
      },
    );
    const values = clip.tracks[0].values;
    expect(values[3]).toBeCloseTo(1, 5);
    expect(values[0]).toBeCloseTo(0, 5);
  });

  it('ref_pose subtracts the REST pose, not the clip’s own frame 0', () => {
    // Rotate the spine rest 90 degrees about X. The clip still holds identity,
    // so the additive delta must be the INVERSE of that rest rotation. A bare
    // makeClipAdditive against the clip's own frame 0 would give identity here.
    const rig = makeRig();
    const spine = rig.getObjectByName('spine_01');
    expect(spine).toBeDefined();
    spine?.quaternion.setFromAxisAngle(new Vector3(1, 0, 0), Math.PI / 2);
    const clip = identityClip();
    bakeAdditive(
      clip,
      { additiveType: 'local', basePoseType: 'ref_pose' },
      {
        clipsByName: new Map(),
        restPose: buildRestPose(rig),
      },
    );
    expect(Math.abs(clip.tracks[0].values[3] - 1)).toBeGreaterThan(1e-3);
  });

  it('throws when ref_pose is asked for without a rest pose', () => {
    expect(() => {
      bakeAdditive(identityClip(), { basePoseType: 'ref_pose' }, { clipsByName: new Map() });
    }).toThrow(/no rest pose/);
  });

  it('throws when anim_frame names a clip that is not loaded', () => {
    expect(() => {
      bakeAdditive(
        identityClip(),
        { basePoseType: 'anim_frame', basePoseClipName: 'missing' },
        { clipsByName: new Map() },
      );
    }).toThrow(/was not found among loaded clips/);
  });

  it('anim_scaled subtracts the base clip per keyframe', () => {
    const clip = identityClip();
    const rotated = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), Math.PI / 2);
    const base = new AnimationClip('base', 2 / 30, [
      new QuaternionKeyframeTrack(
        'spine_01.quaternion',
        [0, 1 / 30],
        [rotated.x, rotated.y, rotated.z, rotated.w, rotated.x, rotated.y, rotated.z, rotated.w],
      ),
    ]);
    bakeAdditive(
      clip,
      { basePoseType: 'anim_scaled', basePoseClipName: 'base' },
      {
        clipsByName: new Map([['base', base]]),
      },
    );
    // delta = base^-1 * identity = inverse of a +90 degree Y rotation.
    expect(clip.tracks[0].values[1]).toBeCloseTo(-rotated.y, 5);
  });

  it('mesh space needs the hierarchy, and buildBoneParents supplies it', () => {
    const rig = makeRig();
    const parents = buildBoneParents(rig);
    expect(parents.get('spine_01')).toBe('pelvis');
    expect(parents.get('pelvis')).toBe('Armature');
    expect(() => {
      bakeAdditive(identityClip(), { additiveType: 'mesh' }, { clipsByName: new Map() });
    }).toThrow(/skeleton hierarchy was not provided/);
  });
});
