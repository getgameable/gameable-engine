// Ported from aos-threejs-poc/tests/unit/bodyMotionClip.test.mjs and
// aos-threejs-poc/tests/unit/generatedGestureClip.test.mjs @ cdd63b10
import { Bone, Object3D } from 'three/webgpu';
import { describe, expect, it } from 'vitest';

import { buildBodyMotionClip, type BodyMotionTracks, computeRootDelta } from './bodyMotionClip';

/** The identity quaternion, xyzw. */
const IDQ = [0, 0, 0, 1];

/**
 * A named bone at a position.
 *
 * @param name Bone name.
 * @param pos Local position.
 *
 * @returns The bone.
 */
function makeBone(name: string, pos: [number, number, number] = [0, 0, 0]): Bone {
  const b = new Bone();
  b.name = name;
  b.position.set(pos[0], pos[1], pos[2]);
  return b;
}

/**
 * root -> Armature -> pelvis -> spine_01, the shape a MetaHuman GLB has.
 *
 * @returns The rig root.
 */
function makeRig(): Object3D {
  const root = new Object3D();
  const armature = new Object3D();
  armature.name = 'Armature';
  const pelvis = makeBone('pelvis', [0, 1, 0]);
  const spine = makeBone('spine_01', [0, 0.2, 0]);
  root.add(armature);
  armature.add(pelvis);
  pelvis.add(spine);
  return root;
}

/**
 * A two-bone identity-rotation payload that travels on +Y and +Z.
 *
 * @param frames Frame count.
 *
 * @returns The payload.
 */
function makeTracks(frames = 2): BodyMotionTracks {
  const pelvis: number[] = [];
  const spine: number[] = [];
  const root: number[] = [];
  for (let f = 0; f < frames; f += 1) {
    pelvis.push(...IDQ);
    spine.push(...IDQ);
    root.push(0, f * 0.5, f * 1.0);
  }
  return { fps: 30, frames, bones: { pelvis, spine_01: spine }, root };
}

/** The only part of a clip these assertions look at. */
interface TrackList {
  /** Its tracks, by name. */
  tracks: { name: string }[];
}

/**
 * Whether a clip carries a named track.
 *
 * @param clip The clip.
 * @param name Track name.
 *
 * @returns Whether it is present.
 */
function hasTrack(clip: TrackList, name: string): boolean {
  return clip.tracks.some((t) => t.name === name);
}

describe('buildBodyMotionClip', () => {
  it("builds the pelvis position track in 'travel' mode", () => {
    const clip = buildBodyMotionClip(makeTracks(), {
      root: makeRig(),
      name: 't',
      rootMode: 'travel',
    });
    expect(hasTrack(clip, 'pelvis.position')).toBe(true);
    expect(hasTrack(clip, 'pelvis.quaternion')).toBe(true);
  });

  it("defaults to 'travel', so the anchor callsite is unchanged", () => {
    const clip = buildBodyMotionClip(makeTracks(), { root: makeRig(), name: 't' });
    expect(hasTrack(clip, 'pelvis.position')).toBe(true);
  });

  it("omits the pelvis position track in 'lock' mode so a gesture plays in place", () => {
    const clip = buildBodyMotionClip(makeTracks(), {
      root: makeRig(),
      name: 't',
      rootMode: 'lock',
    });
    expect(hasTrack(clip, 'pelvis.position')).toBe(false);
    expect(hasTrack(clip, 'pelvis.quaternion')).toBe(true);
  });

  it('reports bones that are absent from the rig rather than throwing', () => {
    const missing: string[] = [];
    const tracks = makeTracks();
    const withGhost: BodyMotionTracks = {
      ...tracks,
      bones: { ...tracks.bones, ghost_bone: [...IDQ, ...IDQ] },
    };
    const clip = buildBodyMotionClip(withGhost, {
      root: makeRig(),
      onMissingBone: (n) => missing.push(n),
    });
    expect(missing).toEqual(['ghost_bone']);
    expect(hasTrack(clip, 'ghost_bone.quaternion')).toBe(false);
  });

  it('sets the duration from frames / fps and produces finite values', () => {
    const clip = buildBodyMotionClip(makeTracks(6), { root: makeRig(), name: 't' });
    expect(clip.duration).toBeCloseTo(6 / 30, 12);
    for (const track of clip.tracks) {
      for (const v of track.values) expect(Number.isFinite(v)).toBe(true);
    }
  });

  it('throws when no bone in the payload exists on the rig', () => {
    const rig = new Object3D();
    expect(() => buildBodyMotionClip(makeTracks(), { root: rig })).toThrow(/no matching bones/);
  });
});

describe('computeRootDelta', () => {
  it('takes [dx, dz] from frame 0 to frame last', () => {
    expect(computeRootDelta({ frames: 2, root: [0, 1, 0, 1.5, 1, -2.5] })).toEqual([1.5, -2.5]);
  });

  it('ignores the middle frames entirely', () => {
    expect(computeRootDelta({ frames: 3, root: [0, 0, 0, 99, 99, 99, 2, 0, 4] })).toEqual([2, 4]);
  });

  it('returns null for a single-frame, in-place payload', () => {
    expect(computeRootDelta({ frames: 1, root: [0, 0, 0] })).toBeNull();
  });

  it('infers the frame count from root.length / 3', () => {
    expect(computeRootDelta({ root: [0, 0, 0, 1, 0, 1] })).toEqual([1, 1]);
  });

  it('returns null for a missing or empty root track', () => {
    expect(computeRootDelta({})).toBeNull();
    expect(computeRootDelta({ root: [] })).toBeNull();
    expect(computeRootDelta(undefined)).toBeNull();
  });
});
