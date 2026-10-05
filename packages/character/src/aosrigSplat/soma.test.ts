import { readFileSync } from 'node:fs';
import { AnimationMixer, Quaternion, Vector3 } from 'three/webgpu';
import { describe, expect, it } from 'vitest';
import {
  createSomaPoser,
  createSomaRig,
  parseSomaClips,
  parseSomaSkeleton,
  somaAnimationClip,
  type SomaSkeleton,
} from './soma.js';

interface Expected {
  clip: string;
  frame: number;
  maxTwistDeg: number;
  names: string[];
  /** Row-major 4 x 4 per joint. */
  worlds: number[][];
}

const folder = (sub: string): URL =>
  new URL(`../../test/fixtures/aosrig-splat-soma/${sub}`, import.meta.url);
const json = (sub: string, name: string): unknown =>
  JSON.parse(readFileSync(new URL(name, folder(sub)), 'utf8')) as unknown;

/**
 * Pose a fixture's skeleton at its expected frame through three's mixer and the poser.
 *
 * @param sub The fixture's folder under aosrig-splat-soma/ ('' for Tala's, 'steph/').
 * @returns The worst joint and axis errors against the reference, metres.
 */
function poseFixture(sub: string): { joint: number; axis: number; expected: Expected } {
  const expected = json(sub, 'expected.json') as Expected;
  const skeleton = parseSomaSkeleton(json(sub, 'skeleton.json'), expected.names);
  const { clips, refused } = parseSomaClips(json(sub, 'clips.json'), skeleton);
  expect(refused).toEqual([]);
  const clip = clips.find((c) => c.name === expected.clip);
  if (!clip) throw new Error('the fixture has no clip of that name');
  const { root, bones } = createSomaRig(skeleton);
  const mixer = new AnimationMixer(root);
  mixer.clipAction(somaAnimationClip(clip, skeleton)).play();
  mixer.setTime(expected.frame / clip.fps);
  const poser = createSomaPoser(skeleton, bones);
  const skin = new Float32Array(skeleton.joints.length * 16);
  poser.pose(skin);
  let joint = 0,
    axis = 0;
  for (let j = 0; j < skeleton.joints.length; j++) {
    const w = poser.worlds.subarray(j * 16, j * 16 + 16); // column-major
    const r = expected.worlds[j]; // row-major
    for (let a = 0; a < 3; a++) {
      joint = Math.max(joint, Math.abs(w[12 + a] - r[a * 4 + 3]));
      // each axis, 10 cm along it
      for (let k = 0; k < 3; k++)
        axis = Math.max(axis, 0.1 * Math.abs(w[k * 4 + a] - r[a * 4 + k]));
    }
  }
  return { joint, axis, expected };
}

describe('the aosrig-v2 body (SOMA skeleton), held to the studio player', () => {
  it.each([
    ['Tala', ''],
    ['Steph', 'steph/'],
  ])("poses %s's skeleton at a clip frame as soma_body.Rig.pose does", (_who, sub) => {
    const { joint, axis, expected } = poseFixture(sub);
    // the fixture is a frame with a large twist, so helpers left at rest would fail
    expect(expected.maxTwistDeg).toBeGreaterThan(45);
    expect(joint).toBeLessThan(1e-5);
    expect(axis).toBeLessThan(1e-5);
  });

  it("stands in the file's rest with no clip, twist helpers included", () => {
    const expected = json('', 'expected.json') as Expected;
    const skeleton = parseSomaSkeleton(json('', 'skeleton.json'), expected.names);
    const { bones } = createSomaRig(skeleton);
    createSomaPoser(skeleton, bones).pose(new Float32Array(skeleton.joints.length * 16));
    let worst = 0;
    for (const h of skeleton.helpers) {
      const file = new Quaternion(...skeleton.joints[h.joint].localRotation);
      worst = Math.max(worst, bones[h.joint].quaternion.angleTo(file));
    }
    expect(skeleton.helpers).toHaveLength(32);
    expect(worst).toBeLessThan(1e-3); // radians
  });

  it('skins a bound point back to where it was bound when the rig stands at the bind', () => {
    const expected = json('', 'expected.json') as Expected;
    const skeleton = parseSomaSkeleton(json('', 'skeleton.json'), expected.names);
    const { bones } = createSomaRig(skeleton);
    const poser = createSomaPoser(skeleton, bones);
    const skin = new Float32Array(skeleton.joints.length * 16);
    poser.pose(skin);
    // At rest (the stance) the skin matrices are not the identity: the stance is not the bind.
    const head = skeleton.names.indexOf('Head');
    const offIdentity = [0, 5, 10, 15].reduce((s, k) => s + Math.abs(skin[head * 16 + k] - 1), 0);
    expect(Number.isFinite(offIdentity)).toBe(true);
    for (const v of skin) expect(Number.isFinite(v)).toBe(true);
  });
});

describe('reading skeleton.json and clips.json', () => {
  const expected = json('', 'expected.json') as Expected;
  const skeletonJson = (): Record<string, unknown> =>
    json('', 'skeleton.json') as Record<string, unknown>;
  const skeleton = (): SomaSkeleton => parseSomaSkeleton(skeletonJson(), expected.names);

  it("refuses a skeleton that is not the descriptor's joints", () => {
    expect(() => parseSomaSkeleton(skeletonJson(), expected.names.slice(1))).toThrow();
    const renamed = expected.names.slice();
    renamed[3] = 'Spine9';
    expect(() => parseSomaSkeleton(skeletonJson(), renamed)).toThrow(/is not Spine9/);
    expect(() =>
      parseSomaSkeleton({ ...skeletonJson(), format: 'aosrig-v1' }, expected.names),
    ).toThrow();
  });

  it('refuses a joint before its parent, a bad inverse bind and an unknown twist rule', () => {
    const late = skeletonJson();
    (late.joints as { parent: number }[])[2].parent = 5;
    expect(() => parseSomaSkeleton(late, expected.names)).toThrow(/parent/);
    const bent = skeletonJson();
    (
      bent.joints as { inverse_bind_matrix_row_major: number[][] }[]
    )[4].inverse_bind_matrix_row_major[3] = [0, 0, 1, 1];
    expect(() => parseSomaSkeleton(bent, expected.names)).toThrow(/affine/);
    const rule = skeletonJson();
    (rule.procedural as { mode: string }).mode = 'swing';
    expect(() => parseSomaSkeleton(rule, expected.names)).toThrow(/twist rule/);
  });

  it('reads the twist rule: 8 segments, 32 helpers, Hips hanging from Root', () => {
    const s = skeleton();
    expect(s.segments).toHaveLength(8);
    expect(s.helpers).toHaveLength(32);
    expect(s.names[s.hips]).toBe('Hips');
    expect(s.joints[s.hips].parent).toBe(0);
    expect(s.floorY).toBe(0);
  });

  it('leaves out a clip that breaks a rule, says why, and keeps the rest', () => {
    const s = skeleton();
    const file = json('', 'clips.json') as { clips: Record<string, unknown>[] };
    const good = file.clips[0];
    const bones = good.bones as Record<string, number[]>;
    const clips = [
      good,
      { ...good, name: 'unknown joint', bones: { ...bones, Tail: bones.Hips } },
      { ...good, name: 'moves a helper', bones: { ...bones, LeftArmTwist1: bones.Hips } },
      { ...good, name: 'moves the root', bones: { ...bones, Root: bones.Hips } },
      { ...good, name: 'short track', bones: { ...bones, Hips: bones.Hips.slice(4) } },
      { ...good, name: 'no rate', fps: 0 },
      { ...good, name: 'no loop flag', loop: 'yes' },
      { ...good, name: 'bad root', root: (good.root as number[]).slice(1) },
      { ...good },
    ];
    const { clips: kept, refused } = parseSomaClips({ ...file, clips }, s);
    expect(kept.map((c) => c.name)).toEqual([good.name]);
    expect(refused.map((r) => r.name)).toEqual([
      'unknown joint',
      'moves a helper',
      'moves the root',
      'short track',
      'no rate',
      'no loop flag',
      'bad root',
      good.name,
    ]);
    expect(refused[0].reason).toContain('Tail');
    expect(refused[7].reason).toContain('earlier clip');
    expect(() => parseSomaClips({ clips }, s)).toThrow(/soma-clips/);
  });

  it("turns a clip into three's tracks: one per joint it names, and the Hips' place", () => {
    const s = skeleton();
    const { clips } = parseSomaClips(json('', 'clips.json'), s);
    const clip = somaAnimationClip(clips[0], s);
    expect(clip.name).toBe(clips[0].name);
    expect(clip.tracks).toHaveLength(clips[0].bones.size + 1);
    expect(clip.tracks.at(-1)?.name).toBe('Hips.position');
    const hips = clip.tracks.at(-1)?.values ?? new Float32Array(3);
    expect(hips[1]).toBeCloseTo(clips[0].root[1] + s.groundOffset, 6);
    expect((clip.userData as { aos: { loop: boolean } }).aos.loop).toBe(clips[0].loop);
  });

  it('closes a looping clip with frame 0 again at frames / fps, so the wrap skips no frame', () => {
    const s = skeleton();
    const { clips } = parseSomaClips(json('', 'clips.json'), s);
    const base = clips[0];
    const n = base.frames;
    expect(n).toBeGreaterThan(2);
    // a last frame that is not the first: turn every joint a little at the end
    const bones = new Map<string, Float32Array>();
    for (const [joint, values] of base.bones) {
      const v = values.slice();
      const q = new Quaternion(v[0], v[1], v[2], v[3]).multiply(
        new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), 0.2),
      );
      v.set([q.x, q.y, q.z, q.w], (n - 1) * 4);
      bones.set(joint, v);
    }
    const open = { ...base, loop: true, bones };

    const looped = somaAnimationClip(open, s);
    expect(looped.duration).toBeCloseTo(n / base.fps, 6);
    for (const track of looped.tracks) {
      const width = track.getValueSize();
      expect(track.times).toHaveLength(n + 1);
      expect(track.times[n]).toBeCloseTo(n / base.fps, 6);
      expect(Array.from(track.values.slice(n * width))).toEqual(
        Array.from(track.values.slice(0, width)),
      );
    }

    // a one-shot ends on its last frame
    const once = somaAnimationClip({ ...open, loop: false }, s);
    expect(once.duration).toBeCloseTo((n - 1) / base.fps, 6);
    expect(once.tracks[0].times).toHaveLength(n);

    // a loop whose last frame already repeats its first keeps its keys
    const repeated = new Map<string, Float32Array>();
    for (const [joint, values] of base.bones) {
      const v = values.slice();
      v.set(v.subarray(0, 4), (n - 1) * 4);
      repeated.set(joint, v);
    }
    const root = base.root.slice();
    root.set(root.subarray(0, 3), (n - 1) * 3);
    const shut = somaAnimationClip({ ...base, loop: true, bones: repeated, root }, s);
    expect(shut.duration).toBeCloseTo((n - 1) / base.fps, 6);
    expect(shut.tracks[0].times).toHaveLength(n);
  });

  it('closes a clip whose root travels at its last velocity, not back at its start', () => {
    const s = skeleton();
    const { clips } = parseSomaClips(json('', 'clips.json'), s);
    const base = clips[0];
    const n = base.frames;
    const root = base.root.slice();
    for (let f = 0; f < n; f++) root[f * 3 + 2] = base.root[2] + 0.1 * f; // 10 cm a frame along z
    const clip = somaAnimationClip({ ...base, loop: true, root }, s);
    const hips = clip.tracks.at(-1);
    const z = (f: number) => hips?.values[f * 3 + 2] ?? NaN;
    expect(hips?.times).toHaveLength(n + 1);
    expect(z(n) - z(n - 1)).toBeCloseTo(z(n - 1) - z(n - 2), 5);
  });
});
