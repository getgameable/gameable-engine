// Ported from aos-threejs-poc/tests/unit/pruneBodyClipTracks.test.mjs @ cdd63b10
import { describe, expect, it } from 'vitest';

import { pruneBodyClipTracks, type PrunableClip } from './pruneBodyClipTracks';

/** A rig with pelvis, spine_01 and head; `ghost_bone` is intentionally absent. */
const RIG = new Set(['pelvis', 'spine_01', 'head']);

/**
 * Build a fake clip. `keys` drives the active-vs-static classification.
 *
 * @param names Track names.
 * @param keys Keyframe count per track.
 *
 * @returns The clip.
 */
function clip(names: string[], keys = 30): PrunableClip {
  return { tracks: names.map((name) => ({ name, times: { length: keys } })) };
}

/**
 * The surviving track names.
 *
 * @param c A pruned clip.
 *
 * @returns Track names.
 */
function trackNames(c: PrunableClip): string[] {
  return c.tracks.map((t) => t.name);
}

describe('pruneBodyClipTracks', () => {
  it('always strips pelvis.scale and keeps pelvis.position with no marker', () => {
    const c = clip(['pelvis.quaternion', 'pelvis.position', 'pelvis.scale', 'spine_01.quaternion']);
    const report = pruneBodyClipTracks(c, RIG);
    expect(trackNames(c)).toEqual(['pelvis.quaternion', 'pelvis.position', 'spine_01.quaternion']);
    expect(report.tracks).toBe(4);
    expect(report.bound).toBe(3);
  });

  it('keeps pelvis.position when the generated marker says keepRootMotion', () => {
    const c = clip(['pelvis.quaternion', 'pelvis.position', 'pelvis.scale']);
    pruneBodyClipTracks(c, RIG, { generatedMarker: { keepRootMotion: true } });
    expect(trackNames(c)).toContain('pelvis.position');
    expect(trackNames(c)).not.toContain('pelvis.scale');
  });

  it('strips pelvis.position when the generated marker opted out of root motion', () => {
    const c = clip(['pelvis.quaternion', 'pelvis.position', 'pelvis.scale']);
    pruneBodyClipTracks(c, RIG, { generatedMarker: { keepRootMotion: false } });
    expect(trackNames(c)).toEqual(['pelvis.quaternion']);
  });

  it('never binds root or Armature tracks, whatever the marker says', () => {
    const c = clip([
      'root.position',
      'root.quaternion',
      'Armature.quaternion',
      'pelvis.quaternion',
    ]);
    pruneBodyClipTracks(c, RIG, { generatedMarker: { keepRootMotion: true } });
    expect(trackNames(c)).toEqual(['pelvis.quaternion']);
  });

  it('reports tracks whose bone is absent from the rig as unbound', () => {
    const c = clip(['pelvis.quaternion', 'ghost_bone.quaternion']);
    const report = pruneBodyClipTracks(c, RIG);
    expect(report.bound).toBe(1);
    expect(report.unbound).toBe(1);
    expect(report.samples).toEqual(['ghost_bone']);
  });

  it('counts static few-key bound tracks without calling them active', () => {
    const c: PrunableClip = {
      tracks: [
        { name: 'pelvis.quaternion', times: { length: 2 } },
        { name: 'spine_01.quaternion', times: { length: 30 } },
      ],
    };
    const report = pruneBodyClipTracks(c, RIG);
    expect(report.bound).toBe(2);
    expect(report.active).toBe(1);
  });

  it('resolves nested node paths down to their leaf bone name', () => {
    const c = clip(['Armature/pelvis/spine_01.quaternion']);
    const report = pruneBodyClipTracks(c, RIG);
    expect(report.bound).toBe(1);
  });
});
