/**
 * The body of an `aosrig-splat` version 2 package: the aosrig-v2 skeleton (`skeleton.json`,
 * SOMA's 110 joints fitted to the character, 32 of them twist helpers), its clips
 * (`clips.json`, format `soma-clips`) and the twist rule the skeleton states (`procedural`,
 * mode `aligned_x_swing_twist`).
 *
 * The studio writes the package (aos-gameable-cc `docs/ENGINE-PACKAGE.md`); its reference
 * player is `companion/soma_body.py` (`Rig.pose`, `twist_angles`), and `soma.test.ts` holds
 * this file to it on a real package's skeleton and clip frame.
 *
 * How a frame is posed (the skeleton's `playback`):
 *
 * - a clip's parent-local quaternions (x y z w) go on the joints of those names; every other
 *   public joint keeps its rest local (the character's stance);
 * - the Hips stand at `(root.x, floor_y + root.y + ground_offset, root.z)`, in the frame of
 *   `Root` (never animated), a `Hips.position` track;
 * - then each twist helper is turned about its own x by a fixed mix of its segment's twist
 *   channels, after the mixer and the head aim have run, before the skin matrices are made;
 * - each skin matrix is `rig-space world . inverse bind` (the bind is the capture pose the
 *   splats were bound in, which is not the stance).
 *
 * Nothing here touches the GPU; everything runs in node.
 */
import {
  AnimationClip,
  Bone,
  Group,
  Matrix4,
  Quaternion,
  QuaternionKeyframeTrack,
  Vector3,
  VectorKeyframeTrack,
  type Object3D,
} from 'three/webgpu';

type Vec3 = readonly [number, number, number];
type Quat = readonly [number, number, number, number];

/** One joint of the skeleton, as `skeleton.json` states it. */
export interface SomaJoint {
  /** The joint's name (`Hips`, `LeftForeArmTwist2` ...). */
  readonly name: string;
  /** Its parent's index, or -1 for `Root`. Parents come before their children. */
  readonly parent: number;
  /** Rest offset in the parent's frame, metres. */
  readonly localPosition: Vec3;
  /** Rest rotation in the parent's frame, x y z w: the character's stance. */
  readonly localRotation: Quat;
  /** Inverse bind matrix (three's column-major order): where the splats were bound. */
  readonly inverseBind: Matrix4;
  /** A twist helper's local rotation before its twist (x y z w); null for every other joint. */
  readonly baseLocalRotation: Quat | null;
}

/** One arm or leg segment the twist rule reads. */
interface SomaSegment {
  readonly start: number;
  readonly end: number;
  readonly parent: number;
  readonly reverse: boolean;
  /** conj(bind) . align of the start, end and parent joints: their frames on the segment. */
  readonly startFrame: Quaternion;
  readonly endFrame: Quaternion;
  readonly parentFrame: Quaternion;
}

/** One twist helper: which joint, about which of its axes, and its mix of channels. */
interface SomaHelper {
  readonly joint: number;
  /** The helper's own axis it turns about (unit). */
  readonly axis: Vector3;
  /** Pairs: joint index whose channel it reads, and the weight (the rule's sign folded in). */
  readonly mix: readonly number[];
}

/** A package's skeleton, validated. */
export interface SomaSkeleton {
  /** Every joint, in the file's order (character.json's `jointNames`). */
  readonly joints: readonly SomaJoint[];
  /** The joint names, same order. */
  readonly names: readonly string[];
  /** Index of `Hips`, where a clip's root track goes. */
  readonly hips: number;
  /** The floor's height in the package frame (0 in every v2 package). */
  readonly floorY: number;
  /** Added to the Hips' height for a clip's root track. */
  readonly groundOffset: number;
  /** The twist rule's segments. */
  readonly segments: readonly SomaSegment[];
  /** The twist helpers, in the file's `twist` order. */
  readonly helpers: readonly SomaHelper[];
}

/** One clip of a `soma-clips` file. */
export interface SomaClip {
  readonly name: string;
  readonly loop: boolean;
  readonly fps: number;
  readonly frames: number;
  /** Per joint name, x y z w per frame. */
  readonly bones: ReadonlyMap<string, Float32Array>;
  /** The Hips' path, x y z per frame (the neutral body's, over its floor). */
  readonly root: Float32Array;
  /** Ground speed in metres per second, when the clip says (a locomotion clip). */
  readonly speed: number;
  /** Whether the clip belongs in the walk and run blend. */
  readonly locomotion: boolean;
}

const finite = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);

/**
 * Narrow a JSON object without assuming the schema being validated.
 *
 * @param value The value.
 * @param what What it is, for the error.
 * @returns The object.
 */
function record(value: unknown, what: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error(`aosrig-splat: ${what} is not an object`);
  return value as Record<string, unknown>;
}

/**
 * A list of `n` finite numbers.
 *
 * @param value The value.
 * @param n How many.
 * @param what What it is, for the error.
 * @returns The numbers.
 */
function numbers(value: unknown, n: number, what: string): number[] {
  if (!Array.isArray(value) || value.length !== n || !value.every(finite))
    throw new Error(`aosrig-splat: ${what} is not ${String(n)} numbers`);
  return value;
}

/**
 * A rotation, x y z w, normalised.
 *
 * @param value The value.
 * @param what What it is, for the error.
 * @returns The unit quaternion.
 */
function quaternion(value: unknown, what: string): Quat {
  const [x, y, z, w] = numbers(value, 4, what);
  const length = Math.hypot(x, y, z, w);
  if (length < 1e-6) throw new Error(`aosrig-splat: ${what} is not a rotation`);
  return [x / length, y / length, z / length, w / length];
}

/**
 * Validate `skeleton.json` against the descriptor's joint names.
 *
 * @param value The parsed JSON.
 * @param jointNames character.json's `jointNames`.
 * @returns The skeleton.
 * @throws {Error} When the file is not an aosrig-v2 skeleton of those joints.
 */
export function parseSomaSkeleton(value: unknown, jointNames: readonly string[]): SomaSkeleton {
  const d = record(value, 'skeleton.json');
  if (d.format !== 'aosrig-v2') throw new Error('aosrig-splat: skeleton.json is not aosrig-v2');
  if (!Array.isArray(d.joints) || d.joints.length !== jointNames.length)
    throw new Error("aosrig-splat: skeleton.json's joints are not character.json's");
  const names = jointNames.slice();
  const index = new Map(names.map((n, i) => [n, i]));
  const joints: SomaJoint[] = d.joints.map((raw: unknown, i: number): SomaJoint => {
    const j = record(raw, `joint ${String(i)}`);
    if (j.name !== names[i])
      throw new Error(`aosrig-splat: skeleton.json's joint ${String(i)} is not ${names[i]}`);
    const parent = j.parent;
    if (
      typeof parent !== 'number' ||
      !Number.isSafeInteger(parent) ||
      parent >= i ||
      parent < -1 ||
      (parent === -1) !== (i === 0)
    )
      throw new Error(`aosrig-splat: ${names[i]}'s parent must come before it (Root first)`);
    const rows = j.inverse_bind_matrix_row_major;
    if (!Array.isArray(rows) || rows.length !== 4)
      throw new Error(`aosrig-splat: ${names[i]}'s inverse bind is not 4 x 4`);
    const m = rows.flatMap((r: unknown, k: number) =>
      numbers(r, 4, `${names[i]}'s inverse bind row ${String(k)}`),
    );
    if (Math.abs(m[12]) + Math.abs(m[13]) + Math.abs(m[14]) + Math.abs(m[15] - 1) > 1e-9)
      throw new Error(`aosrig-splat: ${names[i]}'s inverse bind is not affine`);
    // prettier-ignore
    const inverseBind = new Matrix4().set(
      m[0], m[1], m[2], m[3],
      m[4], m[5], m[6], m[7],
      m[8], m[9], m[10], m[11],
      0, 0, 0, 1,
    );
    const procedural =
      j.procedural === undefined || j.procedural === null
        ? null
        : record(j.procedural, `${names[i]}'s procedural`);
    return {
      name: names[i],
      parent,
      localPosition: numbers(
        j.local_position,
        3,
        `${names[i]}'s local_position`,
      ) as unknown as Vec3,
      localRotation: quaternion(j.local_rotation_xyzw, `${names[i]}'s local_rotation_xyzw`),
      inverseBind,
      baseLocalRotation: procedural
        ? quaternion(procedural.base_local_rotation_xyzw, `${names[i]}'s base local rotation`)
        : null,
    };
  });
  const hips = index.get('Hips');
  if (hips === undefined || !index.has('Head'))
    throw new Error('aosrig-splat: skeleton.json has no Hips or no Head');
  // A clip's root track places the Hips in the frame of the joint above them, which must be
  // the skeleton's root (never animated) for that frame to hold still.
  if (joints[hips].parent !== 0) throw new Error('aosrig-splat: the Hips do not hang from Root');
  const floorY = d.floor_y === undefined || d.floor_y === null ? 0 : d.floor_y;
  const groundOffset = d.ground_offset ?? 0;
  if (!finite(floorY) || !finite(groundOffset))
    throw new Error('aosrig-splat: skeleton.json has a bad floor_y or ground_offset');

  // The twist rule. A skeleton without helpers has none; one with helpers must state it.
  const segments: SomaSegment[] = [];
  const helpers: SomaHelper[] = [];
  const helperJoints = joints.filter((j) => j.baseLocalRotation !== null);
  if (helperJoints.length > 0 || (d.procedural !== undefined && d.procedural !== null)) {
    const p = record(d.procedural, 'skeleton.json procedural');
    if (p.mode !== 'aligned_x_swing_twist')
      throw new Error(`aosrig-splat: unknown twist rule ${String(p.mode)}`);
    const at = (name: unknown, what: string): number => {
      const k = typeof name === 'string' ? index.get(name) : undefined;
      if (k === undefined) throw new Error(`aosrig-splat: the twist rule's ${what} is not a joint`);
      return k;
    };
    const bind = record(p.bind_rotation_xyzw, 'procedural bind_rotation_xyzw');
    const frameOf = (joint: number, align: Quaternion): Quaternion => {
      const b = quaternion(bind[names[joint]], `the bind rotation of ${names[joint]}`);
      return new Quaternion(b[0], b[1], b[2], b[3]).invert().multiply(align);
    };
    if (!Array.isArray(p.segments)) throw new Error('aosrig-splat: the twist rule has no segments');
    for (const [k, raw] of p.segments.entries()) {
      const s = record(raw, `twist segment ${String(k)}`);
      const a = quaternion(s.align_rotation_xyzw, `twist segment ${String(k)}'s align rotation`);
      const align = new Quaternion(a[0], a[1], a[2], a[3]);
      const start = at(s.start, 'segment start'),
        end = at(s.end, 'segment end'),
        parent = at(s.parent, 'segment parent');
      if (typeof s.reverse !== 'boolean')
        throw new Error('aosrig-splat: a twist segment does not say which way it runs');
      segments.push({
        start,
        end,
        parent,
        reverse: s.reverse,
        startFrame: frameOf(start, align),
        endFrame: frameOf(end, align),
        parentFrame: frameOf(parent, align),
      });
    }
    const twist = record(p.twist, 'procedural twist');
    const channels = new Set<number>();
    for (const s of segments) {
      channels.add(s.end);
      if (s.reverse) channels.add(s.start);
    }
    for (const [name, raw] of Object.entries(twist)) {
      const t = record(raw, `the twist of ${name}`);
      const joint = at(name, `helper ${name}`);
      if (joints[joint].baseLocalRotation === null)
        throw new Error(`aosrig-splat: twist helper ${name} has no base local rotation`);
      const axis = t.axis ?? 0;
      const sign = t.sign ?? 1;
      if ((axis !== 0 && axis !== 1 && axis !== 2) || !finite(sign))
        throw new Error(`aosrig-splat: the twist of ${name} has a bad axis or sign`);
      const mix: number[] = [];
      for (const [channel, weight] of Object.entries(record(t.weights, `${name}'s weights`))) {
        const c = at(channel, `channel ${channel}`);
        if (!finite(weight)) throw new Error(`aosrig-splat: ${name}'s weight is not a number`);
        // SOMA-X reads only the channels its segments write; a name it never writes adds nothing.
        if (channels.has(c)) mix.push(c, weight * sign);
      }
      helpers.push({
        joint,
        axis: new Vector3(axis === 0 ? 1 : 0, axis === 1 ? 1 : 0, axis === 2 ? 1 : 0),
        mix,
      });
    }
    if (helpers.length !== helperJoints.length)
      throw new Error('aosrig-splat: a twist helper has no twist in the rule');
    // Helpers are leaves: nothing rides them, so they can be posed after everything else.
    const isHelper = new Set(helpers.map((h) => h.joint));
    if (joints.some((j) => isHelper.has(j.parent)))
      throw new Error('aosrig-splat: a joint hangs from a twist helper');
    for (const s of segments)
      if (isHelper.has(s.start) || isHelper.has(s.end) || isHelper.has(s.parent))
        throw new Error('aosrig-splat: a twist segment reads a twist helper');
  }
  return { joints, names, hips, floorY, groundOffset, segments, helpers };
}

/**
 * Validate a `soma-clips` file (a package's `clips.json`, or a shared clip file of the same
 * format) against a skeleton. A clip that breaks a rule is left out and said, never the
 * whole file.
 *
 * @param value The parsed JSON.
 * @param skeleton The skeleton the clips play on.
 * @returns The clips, and each refused clip with its reason.
 * @throws {Error} When the file is not a `soma-clips` file at all.
 */
export function parseSomaClips(
  value: unknown,
  skeleton: SomaSkeleton,
): { clips: SomaClip[]; refused: { name: string; reason: string }[] } {
  const d = record(value, 'the clip file');
  if (d.format !== 'soma-clips' || !Array.isArray(d.clips))
    throw new Error('aosrig-splat: not a soma-clips file');
  const index = new Map(skeleton.names.map((n, i) => [n, i]));
  const helpers = new Set(skeleton.helpers.map((h) => h.joint));
  const clips: SomaClip[] = [];
  const refused: { name: string; reason: string }[] = [];
  const seen = new Set<string>();
  for (const [k, raw] of d.clips.entries()) {
    const c = raw as Record<string, unknown> | null;
    const name =
      c && typeof c.name === 'string' && c.name.length > 0 ? c.name : `clip ${String(k)}`;
    try {
      if (!c || typeof c !== 'object') throw new Error('is not an object');
      if (typeof c.name !== 'string' || !c.name) throw new Error('has no name');
      if (seen.has(name)) throw new Error('has the name of an earlier clip');
      if (typeof c.loop !== 'boolean') throw new Error('does not say whether it loops');
      if (!finite(c.fps) || c.fps <= 0) throw new Error('has no frame rate');
      const frames = c.frames;
      if (typeof frames !== 'number' || !Number.isSafeInteger(frames) || frames < 1)
        throw new Error('has no frames');
      const track = (v: unknown, width: number, what: string): Float32Array => {
        if (!Array.isArray(v) || v.length !== width * frames || !v.every(finite))
          throw new Error(
            `has a ${what} track that is not ${String(width)} x ${String(frames)} numbers`,
          );
        return Float32Array.from(v);
      };
      const bones = new Map<string, Float32Array>();
      for (const [joint, v] of Object.entries(record(c.bones, 'its bones'))) {
        const j = index.get(joint);
        if (j === undefined) throw new Error(`names ${joint}, which the skeleton does not have`);
        if (j === 0 || helpers.has(j)) throw new Error(`moves ${joint}, which a clip never moves`);
        const q = track(v, 4, joint);
        for (let f = 0; f < frames; f++) {
          const o = f * 4;
          const l = Math.hypot(q[o], q[o + 1], q[o + 2], q[o + 3]);
          if (l < 1e-6) throw new Error(`has a ${joint} frame that is not a rotation`);
          // the studio writes six decimals: normalised here, as its player does
          q[o] /= l;
          q[o + 1] /= l;
          q[o + 2] /= l;
          q[o + 3] /= l;
        }
        bones.set(joint, q);
      }
      const root = track(c.root, 3, 'root');
      const speed = finite(c.speed) && c.speed >= 0 ? c.speed : 0;
      clips.push({
        name,
        loop: c.loop,
        fps: c.fps,
        frames,
        bones,
        root,
        speed,
        locomotion: c.locomotion === true,
      });
      seen.add(name);
    } catch (error) {
      refused.push({ name, reason: error instanceof Error ? error.message : String(error) });
    }
  }
  return { clips, refused };
}

/**
 * A clip as three's mixer plays it: a quaternion track per joint it names and the Hips'
 * position from its root track, in `Root`'s frame. `userData.aos` carries its loop flag and
 * speed, as the engine's clip index reads them.
 *
 * @param clip A parsed clip.
 * @param skeleton The skeleton it plays on.
 * @returns The clip, named as the package names it.
 */
export function somaAnimationClip(clip: SomaClip, skeleton: SomaSkeleton): AnimationClip {
  // A looping clip lasts frames / fps and wraps from its last frame back to its first: that
  // interval needs a closing key (frame 0 again at frames / fps), or three takes the clip to end
  // at the last key and skips it, a one-frame jump at every loop. A clip whose last frame already
  // repeats its first has that interval, and a one-shot ends on its last frame.
  const closes = clip.loop && clip.frames > 1 && !lastRepeatsFirst(clip);
  const keys = clip.frames + (closes ? 1 : 0);
  const times = new Float32Array(keys);
  for (let f = 0; f < keys; f++) times[f] = f / clip.fps;
  const closed = (values: Float32Array, width: number, closing?: Float32Array): Float32Array => {
    if (!closes) return values;
    const out = new Float32Array(keys * width);
    out.set(values.subarray(0, clip.frames * width));
    out.set(closing ?? values.subarray(0, width), clip.frames * width);
    return out;
  };
  const tracks: (QuaternionKeyframeTrack | VectorKeyframeTrack)[] = [];
  for (const [joint, values] of clip.bones)
    tracks.push(new QuaternionKeyframeTrack(`${joint}.quaternion`, times, closed(values, 4)));
  // The Hips' place in the character frame, then into its parent's frame (Root: never
  // animated, at the origin in every package so far).
  const parent = skeleton.joints[skeleton.hips].parent;
  const toParent = new Matrix4();
  if (parent >= 0) {
    const p = skeleton.joints[parent];
    const r = p.localRotation;
    toParent
      .compose(
        new Vector3(...p.localPosition),
        new Quaternion(r[0], r[1], r[2], r[3]),
        new Vector3(1, 1, 1),
      )
      .invert();
  }
  const place = new Vector3();
  const hips = new Float32Array(clip.frames * 3);
  for (let f = 0; f < clip.frames; f++) {
    place
      .set(
        clip.root[f * 3],
        skeleton.floorY + clip.root[f * 3 + 1] + skeleton.groundOffset,
        clip.root[f * 3 + 2],
      )
      .applyMatrix4(toParent);
    hips[f * 3] = place.x;
    hips[f * 3 + 1] = place.y;
    hips[f * 3 + 2] = place.z;
  }
  tracks.push(
    new VectorKeyframeTrack(
      `${skeleton.names[skeleton.hips]}.position`,
      times,
      closed(hips, 3, travels(hips, clip.frames) ? onward(hips, clip.frames) : undefined),
    ),
  );
  const out = new AnimationClip(clip.name, (keys - 1) / clip.fps, tracks);
  out.userData = { aos: { loop: clip.loop, speed: clip.speed, locomotion: clip.locomotion } };
  return out;
}

/** A root that ends further than this from where it starts travels: its loop does not close. */
const TRAVEL_M = 0.05;

/**
 * Whether the Hips' path travels over the clip (a clip with root motion), rather than playing in
 * place.
 *
 * @param hips The Hips' path, x y z per frame.
 * @param frames Its frame count.
 * @returns True when the last frame is more than 5 cm from the first.
 */
function travels(hips: Float32Array, frames: number): boolean {
  const l = (frames - 1) * 3;
  return Math.hypot(hips[l] - hips[0], hips[l + 1] - hips[1], hips[l + 2] - hips[2]) > TRAVEL_M;
}

/**
 * The Hips' place one frame past the last, at the last frame's velocity: the closing key of a clip
 * that travels, which goes on instead of gliding back to its start.
 *
 * @param hips The Hips' path, x y z per frame.
 * @param frames Its frame count (at least 2).
 * @returns The place.
 */
function onward(hips: Float32Array, frames: number): Float32Array {
  const l = (frames - 1) * 3;
  const p = l - 3;
  return Float32Array.of(
    2 * hips[l] - hips[p],
    2 * hips[l + 1] - hips[p + 1],
    2 * hips[l + 2] - hips[p + 2],
  );
}

/**
 * Whether a clip's last frame repeats its first (every joint within about 0.1 degrees, and the
 * Hips' path within 0.1 mm), so the loop's wrap is already in the clip.
 *
 * @param clip A parsed clip.
 * @returns True when the last frame is a copy of the first.
 */
function lastRepeatsFirst(clip: SomaClip): boolean {
  const last = clip.frames - 1;
  const near = (values: Float32Array, width: number, eps: number): boolean => {
    for (let k = 0; k < width; k++)
      if (Math.abs(values[last * width + k] - values[k]) > eps) return false;
    return true;
  };
  for (const values of clip.bones.values()) {
    // q and -q are the same rotation
    const dot =
      values[last * 4] * values[0] +
      values[last * 4 + 1] * values[1] +
      values[last * 4 + 2] * values[2] +
      values[last * 4 + 3] * values[3];
    if (Math.abs(dot) < 1 - 1e-6) return false;
  }
  return near(clip.root, 3, 1e-4);
}

/**
 * The skeleton as three bones at rest (the stance), under one group: what the engine's
 * animator and mixer drive, named as the file names them.
 *
 * @param skeleton The skeleton.
 * @returns The group and the bones in the skeleton's order.
 */
export function createSomaRig(skeleton: SomaSkeleton): { root: Group; bones: Bone[] } {
  const root = new Group();
  root.name = 'aosrig-v2';
  const bones = skeleton.joints.map((j) => {
    const bone = new Bone();
    bone.name = j.name;
    bone.position.set(...j.localPosition);
    bone.quaternion.set(...j.localRotation);
    return bone;
  });
  skeleton.joints.forEach((j, i) => {
    (j.parent < 0 ? root : bones[j.parent]).add(bones[i]);
  });
  return { root, bones };
}

/**
 * SOMA-X's twist angle about x of a rotation (q and -q alike).
 *
 * @param q The rotation.
 * @returns Radians.
 */
function twistX(q: Quaternion): number {
  const s = q.w < 0 ? -1 : 1;
  return 4 * Math.atan2(s * q.x, s * q.w + Math.hypot(q.x, q.y, q.z, q.w));
}

/** Poses a rig built by {@link createSomaRig} and writes its skin matrices. */
export interface SomaPoser {
  /**
   * Turn the twist helpers from the pose on the bones (the mixer's and the head aim's
   * work), write their rotations back onto their bones, and write every joint's skin
   * matrix (`rig-space world . inverse bind`, column-major) into `out`.
   *
   * @param out 16 floats per joint, at least.
   */
  pose(out: Float32Array): void;
  /** Each joint's rig-space world, from the last `pose` (16 per joint, column-major). */
  readonly worlds: Float64Array;
}

/**
 * The per-frame poser for a skeleton's bones. Allocation-free after construction.
 *
 * @param skeleton The skeleton.
 * @param bones Its bones, in its order (`createSomaRig`'s).
 * @returns The poser.
 */
export function createSomaPoser(skeleton: SomaSkeleton, bones: readonly Object3D[]): SomaPoser {
  const J = skeleton.joints.length;
  if (bones.length !== J) throw new Error('aosrig-splat: the rig is not the skeleton');
  const isHelper = new Uint8Array(J);
  for (const h of skeleton.helpers) isHelper[h.joint] = 1;
  const rotation = Array.from({ length: J }, () => new Quaternion());
  const position = Array.from({ length: J }, () => new Vector3());
  const channel = new Float64Array(J);
  const worlds = new Float64Array(J * 16);
  const base = skeleton.joints.map((j) =>
    j.baseLocalRotation ? new Quaternion(...j.baseLocalRotation) : new Quaternion(),
  );
  const a = new Quaternion(),
    b = new Quaternion(),
    turn = new Quaternion(),
    offset = new Vector3(),
    one = new Vector3(1, 1, 1),
    world = new Matrix4(),
    skin = new Matrix4();
  const place = (j: number): void => {
    const bone = bones[j];
    const p = skeleton.joints[j].parent;
    if (p < 0) {
      rotation[j].copy(bone.quaternion);
      position[j].copy(bone.position);
      return;
    }
    rotation[j].copy(rotation[p]).multiply(bone.quaternion);
    position[j].copy(offset.copy(bone.position).applyQuaternion(rotation[p])).add(position[p]);
  };
  return {
    worlds,
    pose(out) {
      for (let j = 0; j < J; j++) if (!isHelper[j]) place(j);
      // The segments' channels from the public joints' rotations (a global turn cancels).
      for (const s of skeleton.segments) {
        a.copy(rotation[s.start]).multiply(s.startFrame);
        b.copy(rotation[s.end]).multiply(s.endFrame);
        channel[s.end] = twistX(a.invert().multiply(b));
      }
      for (const s of skeleton.segments) {
        if (!s.reverse) continue;
        a.copy(rotation[s.parent]).multiply(s.parentFrame);
        b.copy(rotation[s.start]).multiply(s.startFrame);
        channel[s.start] = twistX(a.invert().multiply(b));
      }
      for (const h of skeleton.helpers) {
        let angle = 0;
        for (let k = 0; k < h.mix.length; k += 2) angle += h.mix[k + 1] * channel[h.mix[k]];
        bones[h.joint].quaternion
          .copy(base[h.joint])
          .multiply(turn.setFromAxisAngle(h.axis, angle));
        place(h.joint);
      }
      for (let j = 0; j < J; j++) {
        world.compose(position[j], rotation[j], one);
        world.toArray(worlds, j * 16);
        skin.multiplyMatrices(world, skeleton.joints[j].inverseBind);
        skin.toArray(out, j * 16);
      }
    },
  };
}
