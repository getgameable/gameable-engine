// Ported from aos-threejs-poc/src/lib/bodyMotionClip.js @ cdd63b10
/**
 * bodyMotionClip — turn a generated per-frame bone-quaternion payload into a
 * first-class mixer clip.
 *
 * It bakes the root-bone up-axis correction (cancelling the rotation the rig
 * nests above the pelvis) and the world-metre -> pelvis-local root translation
 * directly into keyframes, so the mixer drives it as an ordinary
 * `AnimationAction` rather than a bespoke post-mixer override.
 *
 * The POC read the rig from `window.__AVATAR_SCENE__` and registered the clip
 * into `window.__AVATAR_MIXER__` / `window.__AVATAR_ACTIONS__` through a
 * `window.__DIRECT_PLAY__` hold. All of that is gone: the rig root is injected,
 * and registering the clip is `animator.addClip(name, clip)`. `playGeneratedClip`
 * had no portable core left once the globals went, so it is not ported —
 * {@link computeRootDelta} is, because the root-motion commit formula is the
 * part that was hard to get right.
 */
import {
  AnimationClip,
  type KeyframeTrack,
  type Object3D,
  Quaternion,
  QuaternionKeyframeTrack,
  Vector3,
  VectorKeyframeTrack,
} from 'three/webgpu';

/** The rig's root bone; the only bone whose translation a generated clip drives. */
const ROOT_BONE = 'pelvis';

/** A generated motion payload: per-frame bone quaternions plus a world root track. */
export interface BodyMotionTracks {
  /** Sample rate; defaults to 30. */
  fps?: number;
  /** Frame count; inferred from the first bone track when omitted. */
  frames?: number;
  /** Bone name to a flat `xyzw` stream, four floats per frame. */
  bones: Readonly<Record<string, ArrayLike<number>>>;
  /** Flat world-metre `xyz` root stream, three floats per frame. */
  root?: ArrayLike<number>;
}

/**
 * How the pelvis translation is handled.
 *
 * `travel` builds the pelvis position track so the clip locomotes — walk and
 * jump leave the ground. `lock` skips it so the motion plays IN PLACE, which is
 * the shape a gesture wants: the pelvis stays at rest and the clip can layer
 * additively over the base pose without dragging the body across the floor.
 * Bone rotations are identical either way.
 */
export type RootMode = 'travel' | 'lock';

/** Options for {@link buildBodyMotionClip}. */
export interface BuildBodyMotionClipOptions {
  /** The rig root the clip binds to. Replaces the POC's `window.__AVATAR_SCENE__`. */
  root: Object3D;
  /** Clip name; defaults to `generated_motion`. */
  name?: string;
  /** See {@link RootMode}; defaults to `travel`. */
  rootMode?: RootMode;
  /**
   * Called once per bone name that is absent from the rig, instead of the POC's
   * `console.warn`. Omit to ignore missing bones silently.
   */
  onMissingBone?: (boneName: string) => void;
}

/**
 * Build an `AnimationClip` bound to a live rig from a generated tracks payload.
 *
 * @param tracks The payload; see {@link BodyMotionTracks}.
 * @param options See {@link BuildBodyMotionClipOptions}.
 *
 * @returns The clip, ready for `mixer.clipAction`.
 *
 * @throws {Error} When the payload is empty or no bone in it exists on the rig.
 */
export function buildBodyMotionClip(
  tracks: BodyMotionTracks,
  options: BuildBodyMotionClipOptions,
): AnimationClip {
  const rootMode: RootMode = options.rootMode ?? 'travel';
  const rigRoot = options.root;
  const name = options.name ?? 'generated_motion';

  const boneNames = Object.keys(tracks.bones);
  if (boneNames.length === 0) throw new Error('buildBodyMotionClip: empty tracks');

  const fps = tracks.fps !== undefined && tracks.fps > 0 ? tracks.fps : 30;
  const nFrames = tracks.frames ?? tracks.bones[boneNames[0]].length / 4;
  const times = new Float32Array(nFrames);
  for (let f = 0; f < nFrames; f += 1) times[f] = f / fps;

  // Root correction chain: the rotation and scale the rig nests ABOVE the
  // pelvis, accumulated rig-root -> pelvis.parent. Cancels the Armature's +90
  // X and its centimetre->metre scale, so the clip's glTF-Y-up pelvis is not
  // tipped and world-metre travel maps into pelvis-local space.
  const rootCorr = new Quaternion();
  let rootInvScale = 1;
  let pelvisRest: Vector3 | null = null;
  const pelvis = rigRoot.getObjectByName(ROOT_BONE);
  if (pelvis !== undefined && pelvis.parent !== null) {
    let scl = 1;
    for (let n: Object3D | null = pelvis.parent; n !== null && n !== rigRoot; n = n.parent) {
      rootCorr.premultiply(n.quaternion);
      scl *= n.scale.x;
    }
    rootCorr.invert();
    rootInvScale = scl !== 0 ? 1 / scl : 1;
    pelvisRest = pelvis.position.clone();
  }
  const applyRootCorr = Math.abs(rootCorr.w) < 0.99999;

  const keyTracks: KeyframeTrack[] = [];
  const q = new Quaternion();
  for (const boneName of boneNames) {
    if (rigRoot.getObjectByName(boneName) === undefined) {
      options.onMissingBone?.(boneName);
      continue;
    }
    const src = tracks.bones[boneName];
    const quat = new Float32Array(nFrames * 4);
    for (let f = 0; f < nFrames; f += 1) {
      const o = f * 4;
      q.set(src[o], src[o + 1], src[o + 2], src[o + 3]);
      if (boneName === ROOT_BONE && applyRootCorr) q.premultiply(rootCorr);
      quat[o] = q.x;
      quat[o + 1] = q.y;
      quat[o + 2] = q.z;
      quat[o + 3] = q.w;
    }
    keyTracks.push(new QuaternionKeyframeTrack(`${boneName}.quaternion`, times, quat));
  }
  if (keyTracks.length === 0) throw new Error('buildBodyMotionClip: no matching bones on rig');

  // Pelvis position (locomotion): rest + pelvis-local delta-from-frame-0, so
  // walk and jump travel and leave the ground. Position tracks are stripped at
  // rig load, so a clip position track drives the pelvis directly. Skipped
  // entirely in `lock` mode.
  const rootTrack = tracks.root;
  if (
    rootMode !== 'lock' &&
    rootTrack !== undefined &&
    rootTrack.length >= 3 &&
    pelvisRest !== null
  ) {
    const r0x = rootTrack[0];
    const r0y = rootTrack[1];
    const r0z = rootTrack[2];
    const pos = new Float32Array(nFrames * 3);
    const v = new Vector3();
    for (let f = 0; f < nFrames; f += 1) {
      v.set(rootTrack[f * 3] - r0x, rootTrack[f * 3 + 1] - r0y, rootTrack[f * 3 + 2] - r0z);
      v.applyQuaternion(rootCorr).multiplyScalar(rootInvScale);
      pos[f * 3] = pelvisRest.x + v.x;
      pos[f * 3 + 1] = pelvisRest.y + v.y;
      pos[f * 3 + 2] = pelvisRest.z + v.z;
    }
    keyTracks.push(new VectorKeyframeTrack(`${ROOT_BONE}.position`, times, pos));
  }

  return new AnimationClip(name, nFrames / fps, keyTracks);
}

/**
 * Compute the `[dx, dz]` world-metre XZ root travel — frame-last minus frame-0
 * — from a generated tracks payload's `root` stream.
 *
 * This is the root-motion commit: when a travelling clip finishes, the
 * character must be MOVED by this delta so the resuming base pose continues
 * from the destination instead of snapping back to where the clip started. Y is
 * dropped because the floor owns it.
 *
 * @param tracks A payload, or any object carrying `root` and `frames`.
 *
 * @returns `[dx, dz]`, or null with fewer than two frames (nothing to commit).
 */
export function computeRootDelta(
  tracks?: Pick<BodyMotionTracks, 'root' | 'frames'> | null,
): [number, number] | null {
  const r = tracks?.root;
  if (r === undefined) return null;
  const nf = tracks?.frames ?? Math.floor(r.length / 3);
  if (nf < 2) return null;
  return [r[(nf - 1) * 3] - r[0], r[(nf - 1) * 3 + 2] - r[2]];
}
