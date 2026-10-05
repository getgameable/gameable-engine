import { AnimationClip, QuaternionKeyframeTrack } from 'three/webgpu';
import { IDENTITY_QUAT, quatInvert, quatMultiply, rebindQuaternionTrack } from './retarget';

/** Parent-first rest skeleton in metres, Y-up, xyzw rotations. */
export interface RestSkeleton {
  names: readonly string[];
  parents: readonly number[];
  rotations: readonly (readonly number[])[];
}
/** Prepared local quaternion tracks emitted by a motion service. */
export interface PreparedMotion {
  fps: number;
  frames: number;
  bones: Readonly<Record<string, readonly number[] | undefined>>;
}
/**
 * Retarget selected joints into additive bind-relative rotations. Translation
 * is deliberately excluded: stationary interviews keep their base pose's feet.
 * The explicit bone map should contain upper-body joints only.
 *
 * @param name Clip/gesture id.
 * @param motion Source local quaternion samples.
 * @param source Source rest skeleton, including unanimated ancestors.
 * @param target Target rest skeleton, including unanimated ancestors.
 * @param boneMap Source-to-target upper-body joint names.
 * @returns Additive clip; register with additive true and loop false.
 */
export function retargetStationaryGesture(
  name: string,
  motion: PreparedMotion,
  source: RestSkeleton,
  target: RestSkeleton,
  boneMap: Readonly<Record<string, string>>,
): AnimationClip {
  if (
    !Number.isFinite(motion.fps) ||
    motion.fps <= 0 ||
    motion.fps > 240 ||
    !Number.isInteger(motion.frames) ||
    motion.frames < 2 ||
    motion.frames > 7200
  )
    throw new Error('Invalid motion timing');
  const world = (skeleton: RestSkeleton): number[][] => {
    const result: number[][] = [];
    if (
      skeleton.names.length !== skeleton.parents.length ||
      skeleton.names.length !== skeleton.rotations.length
    )
      throw new Error('Invalid rest skeleton');
    for (let i = 0; i < skeleton.names.length; i++) {
      const parent = skeleton.parents[i];
      const q = skeleton.rotations[i];
      if (
        !Number.isInteger(parent) ||
        parent < -1 ||
        parent >= i ||
        q.length !== 4 ||
        q.some((v) => !Number.isFinite(v)) ||
        Math.abs(Math.hypot(...q) - 1) > 0.01
      )
        throw new Error('Invalid rest transform');
      result.push(quatMultiply(parent < 0 ? IDENTITY_QUAT : result[parent], q, []));
    }
    return result;
  };
  const srcWorld = world(source);
  const dstWorld = world(target);
  const times = Float32Array.from({ length: motion.frames }, (_, i) => i / motion.fps);
  const tracks: QuaternionKeyframeTrack[] = [];
  for (const [from, to] of Object.entries(boneMap)) {
    const s = source.names.indexOf(from),
      t = target.names.indexOf(to);
    if (s < 0 || t < 0) throw new Error(`Unknown mapped joint: ${from} -> ${to}`);
    const raw = motion.bones[from];
    if (raw === undefined) continue;
    if (raw.length !== motion.frames * 4 || raw.some((v) => !Number.isFinite(v)))
      throw new Error(`Invalid motion track: ${from}`);
    const values = new Float32Array(raw);
    rebindQuaternionTrack(values, {
      srcRest: srcWorld[s],
      srcParentRest: srcWorld[source.parents[s]] ?? IDENTITY_QUAT,
      dstRest: dstWorld[t],
      dstParentRest: dstWorld[target.parents[t]] ?? IDENTITY_QUAT,
    });
    const inverseRest = quatInvert(target.rotations[t]);
    const q = [0, 0, 0, 1];
    const delta: number[] = [];
    for (let i = 0; i < values.length; i += 4) {
      for (let j = 0; j < 4; j++) q[j] = values[i + j];
      quatMultiply(inverseRest, q, delta);
      const length = Math.hypot(...delta);
      if (length < 1e-8) throw new Error('Zero motion quaternion');
      for (let j = 0; j < 4; j++) values[i + j] = delta[j] / length;
    }
    tracks.push(new QuaternionKeyframeTrack(`${to}.quaternion`, times, values));
  }
  if (tracks.length === 0) throw new Error('No mapped gesture tracks');
  return new AnimationClip(name, (motion.frames - 1) / motion.fps, tracks);
}
