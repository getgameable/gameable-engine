// Ported from aos-threejs-poc/src/lib/additiveBake.js @ cdd63b10
/**
 * additiveBake — Unreal-parity additive baking.
 *
 * Unreal exposes three additive controls on an animation asset:
 *
 *  - Additive Anim Type  (`none` | `local` | `mesh`)  — how the delta is computed
 *  - Base Pose Type      (`none` | `ref_pose` | `anim_scaled` | `anim_frame` |
 *                         `local_frame`) — what pose counts as "zero"
 *  - Ref Frame Index     (int) — which frame of the base
 *
 * Those settings are stripped during FBX -> GLB export, so they are re-declared
 * alongside the clip and reproduced here at load time. This mirrors Unreal,
 * where the additive delta is baked at asset-build time and not at the
 * ApplyAdditive graph node, so NOTHING here runs per frame.
 *
 * `local`/`local_frame`, `local`/`anim_frame` and `local`/`ref_pose` reduce to
 * native `AnimationUtils.makeClipAdditive` calls. `mesh` and `anim_scaled` have
 * no three equivalent and are baked manually below.
 *
 * The POC's `window.__ADDITIVE_BAKE__` test hook is gone; the functions are
 * exported and the tests import them.
 */
import {
  AnimationClip,
  AnimationUtils,
  type Interpolant,
  type KeyframeTrack,
  type Object3D,
  Quaternion,
  QuaternionKeyframeTrack,
  VectorKeyframeTrack,
} from 'three/webgpu';

/**
 * `makeClipAdditive` treats `referenceFrame` as a frame index converted to time
 * via `fps`. The conversion pipeline samples clips at 30 fps, so a Ref Frame
 * Index of N maps to N/30 seconds into the reference clip.
 */
const DEFAULT_FPS = 30;

/** How the additive delta is computed. */
export type AdditiveType = 'none' | 'local' | 'mesh';

/** What pose counts as "zero" for the delta. */
export type BasePoseType = 'none' | 'ref_pose' | 'anim_scaled' | 'anim_frame' | 'local_frame';

/** The additive settings as authored, all optional. */
export interface AdditiveSettings {
  /** Unreal's Additive Anim Type. */
  additiveType?: AdditiveType;
  /** Unreal's Base Pose Type. */
  basePoseType?: BasePoseType;
  /** Clip name the base pose is taken from, for `anim_frame` and `anim_scaled`. */
  basePoseClipName?: string | null;
  /** Unreal's Ref Frame Index. */
  refFrameIndex?: number;
}

/** The additive settings with every default filled in. */
export interface ResolvedAdditiveSettings {
  /** Never `none`. */
  additiveType: Exclude<AdditiveType, 'none'>;
  /** Never `none`. */
  basePoseType: Exclude<BasePoseType, 'none'>;
  /** Clip name the base pose is taken from, or null. */
  basePoseClipName: string | null;
  /** Ref Frame Index, defaulting to 0. */
  refFrameIndex: number;
}

/** One bone's rest (bind) transform. */
export interface RestPoseEntry {
  /** Local position. */
  position: [number, number, number];
  /** Local rotation, xyzw. */
  quaternion: [number, number, number, number];
  /** Local scale. */
  scale: [number, number, number];
}

/** Rest transforms by node name. */
export type RestPose = Map<string, RestPoseEntry>;

/** What {@link bakeAdditive} needs besides the clip itself. */
export interface AdditiveBakeContext {
  /** Every loaded clip by name, for the `anim_frame` and `anim_scaled` modes. */
  clipsByName: ReadonlyMap<string, AnimationClip>;
  /** Rest pose, required by `ref_pose` and by mesh-space baking. */
  restPose?: RestPose;
  /** Child node name to parent node name, required by mesh-space baking. */
  boneParents?: ReadonlyMap<string, string>;
  /** Sample rate the Ref Frame Index is interpreted against; defaults to 30. */
  fps?: number;
}

/**
 * Read the rig's rest (bind) pose straight off the loaded rig root.
 *
 * At load time — before the mixer plays anything — every bone sits at its rest
 * local transform, which is exactly Unreal's "Skeleton Reference Pose".
 *
 * @param root The rig root, freshly loaded and not yet posed.
 *
 * @returns Rest transforms by node name.
 */
export function buildRestPose(root: Object3D): RestPose {
  const rest: RestPose = new Map();
  root.traverse((n) => {
    if (n.name === '') return;
    rest.set(n.name, {
      position: [n.position.x, n.position.y, n.position.z],
      quaternion: [n.quaternion.x, n.quaternion.y, n.quaternion.z, n.quaternion.w],
      scale: [n.scale.x, n.scale.y, n.scale.z],
    });
  });
  return rest;
}

/**
 * Build a child -> parent node-name map from the rig hierarchy.
 *
 * @param root The rig root.
 *
 * @returns Child node name to parent node name.
 */
export function buildBoneParents(root: Object3D): Map<string, string> {
  const parents = new Map<string, string>();
  root.traverse((n) => {
    if (n.name === '') return;
    const parent = n.parent;
    if (parent !== null && parent.name !== '') parents.set(n.name, parent.name);
  });
  return parents;
}

/** A track name split into its node path and its property. */
interface SplitTrack {
  /** Everything before the last dot. */
  node: string;
  /** Everything after the last dot: `position`, `quaternion` or `scale`. */
  prop: string;
}

/**
 * Split `"boneName.property"`.
 *
 * @param trackName The track name.
 *
 * @returns The node path and the property.
 */
function splitTrack(trackName: string): SplitTrack {
  const dot = trackName.lastIndexOf('.');
  if (dot < 0) return { node: trackName, prop: '' };
  return { node: trackName.substring(0, dot), prop: trackName.substring(dot + 1) };
}

/**
 * The last path segment of a node path.
 *
 * @param nodePath A track's node path.
 *
 * @returns The leaf node name.
 */
function leafOf(nodePath: string): string {
  return nodePath.split('/').pop() ?? nodePath;
}

/**
 * Build a synthetic one-frame reference clip from the rest pose.
 *
 * One track per track in `targetClip` so `makeClipAdditive` can match by name.
 * Tracks whose bone is absent from the rest pose are skipped, which leaves the
 * corresponding target track unchanged.
 *
 * @param targetClip The clip being baked.
 * @param restPose The rest pose.
 *
 * @returns The reference clip.
 */
function referenceClipFromRestPose(targetClip: AnimationClip, restPose: RestPose): AnimationClip {
  const tracks: KeyframeTrack[] = [];
  for (const t of targetClip.tracks) {
    const { node, prop } = splitTrack(t.name);
    const rest = restPose.get(leafOf(node)) ?? restPose.get(node);
    if (rest === undefined) continue;
    if (prop === 'quaternion') {
      tracks.push(new QuaternionKeyframeTrack(t.name, [0], rest.quaternion.slice()));
    } else if (prop === 'position') {
      tracks.push(new VectorKeyframeTrack(t.name, [0], rest.position.slice()));
    } else if (prop === 'scale') {
      tracks.push(new VectorKeyframeTrack(t.name, [0], rest.scale.slice()));
    }
  }
  return new AnimationClip(`${targetClip.name}__refpose`, -1, tracks);
}

/**
 * Resolve a possibly-missing or partial settings object into a concrete spec.
 *
 * Clips that are additive but carry no explicit config fall back to the
 * historical behaviour: local space, referenced against frame 0 of themselves,
 * i.e. a bare `makeClipAdditive(clip)` call.
 *
 * @param settings The authored settings, or null.
 *
 * @returns The resolved spec.
 */
export function resolveAdditiveSettings(
  settings?: AdditiveSettings | null,
): ResolvedAdditiveSettings {
  const s = settings ?? {};
  const additiveType =
    s.additiveType !== undefined && s.additiveType !== 'none' ? s.additiveType : 'local';
  const basePoseType =
    s.basePoseType !== undefined && s.basePoseType !== 'none' ? s.basePoseType : 'local_frame';
  return {
    additiveType,
    basePoseType,
    basePoseClipName: s.basePoseClipName ?? null,
    refFrameIndex:
      s.refFrameIndex !== undefined && Number.isFinite(s.refFrameIndex) ? s.refFrameIndex : 0,
  };
}

/**
 * One interpolant per track, for the lifetime of that track.
 *
 * Baking samples a base track once per keyframe of the target track, inside a
 * loop over tracks: building an interpolant (and copying its result out with
 * `Array.from`) per sample made a 600-key clip on a 114-bone rig allocate tens
 * of thousands of objects during load, which is a visible hitch. The
 * interpolant reads the track's live `values`, so reusing one across a bake
 * that mutates those values in place is exactly what a fresh one did.
 */
const interpolants = new WeakMap<KeyframeTrack, Interpolant>();

/**
 * The track's interpolant, built once.
 *
 * @param track The track.
 *
 * @returns Its interpolant.
 */
function interpolantOf(track: KeyframeTrack): Interpolant {
  const cached = interpolants.get(track);
  if (cached !== undefined) return cached;
  // `createInterpolant` is assigned in the KeyframeTrack constructor from the
  // track's interpolation setting, so @types/three does not declare it even
  // though it is the only way to sample a track the way it will actually be
  // played. Going through `InterpolantFactoryMethodLinear` instead would
  // silently ignore a track authored with discrete or smooth interpolation.
  const factory = track as unknown as { createInterpolant(): Interpolant };
  const interpolant = factory.createInterpolant();
  interpolants.set(track, interpolant);
  return interpolant;
}

/**
 * Sample a track's value at an arbitrary time using its interpolant.
 *
 * @param track The track.
 * @param time Time in seconds.
 *
 * @returns The interpolant's OWN result buffer, sized to the track's value
 *   size. Read it before sampling the same track again; it is overwritten.
 */
function sampleTrack(track: KeyframeTrack, time: number): ArrayLike<number> {
  return interpolantOf(track).evaluate(time);
}

/**
 * `anim_scaled` (Unreal `ABPT_AnimScaled`): the base pose is the WHOLE base
 * clip, time-normalised to the target clip's duration, subtracted per frame.
 * `makeClipAdditive` only subtracts a single reference frame, so the
 * per-keyframe subtraction is done here.
 *
 * @param clip The clip being baked, mutated in place.
 * @param baseClip The base clip.
 */
function bakeAnimScaledAdditive(clip: AnimationClip, baseClip: AnimationClip): void {
  const targetLen = clip.duration > 0 ? clip.duration : 1;
  const baseLen = baseClip.duration > 0 ? baseClip.duration : 1;
  const baseByName = new Map<string, KeyframeTrack>();
  for (const t of baseClip.tracks) baseByName.set(t.name, t);

  const tq = new Quaternion();
  const bq = new Quaternion();

  for (const track of clip.tracks) {
    const baseTrack = baseByName.get(track.name);
    if (baseTrack === undefined) continue;
    const { prop } = splitTrack(track.name);
    const times = track.times;
    const values = track.values;
    const stride = track.getValueSize();
    // One interpolant for this base track, reused across every keyframe of the
    // target track; `evaluate` writes into its own buffer.
    const baseInterpolant = interpolantOf(baseTrack);

    for (let i = 0; i < times.length; i += 1) {
      const baseTime = (times[i] / targetLen) * baseLen;
      const baseVal = baseInterpolant.evaluate(baseTime);
      const off = i * stride;
      if (prop === 'quaternion') {
        // additive = base^-1 * target (delta rotation)
        tq.set(values[off], values[off + 1], values[off + 2], values[off + 3]);
        bq.set(baseVal[0], baseVal[1], baseVal[2], baseVal[3]).invert().multiply(tq);
        values[off] = bq.x;
        values[off + 1] = bq.y;
        values[off + 2] = bq.z;
        values[off + 3] = bq.w;
      } else {
        // position / scale: component subtraction, matching makeClipAdditive.
        for (let c = 0; c < stride; c += 1) values[off + c] -= baseVal[c];
      }
    }
  }
}

/** Everything mesh-space baking needs beyond the clip. */
interface MeshBakeOptions {
  /** Resolved base pose type. */
  basePoseType: Exclude<BasePoseType, 'none'>;
  /** Base clip name, when the base pose comes from another clip. */
  basePoseClipName: string | null;
  /** Ref Frame Index. */
  refFrameIndex: number;
}

/**
 * Provide the LOCAL base rotation for a bone at a time, per the chosen base
 * pose type. Used by the mesh-space accumulation.
 *
 * @param clip The clip being baked.
 * @param opts Mesh bake options.
 * @param ctx Bake context.
 * @param fps Sample rate the Ref Frame Index is interpreted against.
 *
 * @returns A function from bone leaf name to its local base rotation.
 */
function makeBaseRotationProvider(
  clip: AnimationClip,
  opts: MeshBakeOptions,
  ctx: AdditiveBakeContext,
  fps: number,
): (boneLeaf: string, out: Quaternion) => Quaternion {
  const restPose = ctx.restPose;

  /**
   * The bone's rest rotation.
   *
   * @param boneLeaf Bone leaf name.
   * @param out Quaternion written in place.
   *
   * @returns `out`.
   */
  function restRot(boneLeaf: string, out: Quaternion): Quaternion {
    const rest = restPose?.get(boneLeaf);
    if (rest === undefined) return out.set(0, 0, 0, 1);
    return out.set(rest.quaternion[0], rest.quaternion[1], rest.quaternion[2], rest.quaternion[3]);
  }

  if (opts.basePoseType === 'ref_pose') return restRot;

  // anim_frame / local_frame: a single frame of a clip (base clip or self).
  const baseClip =
    opts.basePoseType === 'anim_frame' && opts.basePoseClipName !== null
      ? ctx.clipsByName.get(opts.basePoseClipName)
      : clip;
  if (baseClip === undefined) {
    throw new Error(
      `[additiveBake] mesh-space base pose clip "${String(opts.basePoseClipName)}" not found`,
    );
  }

  const baseRotByBone = new Map<string, KeyframeTrack>();
  for (const tr of baseClip.tracks) {
    const { node, prop } = splitTrack(tr.name);
    if (prop === 'quaternion') baseRotByBone.set(leafOf(node), tr);
  }
  const refTime = opts.refFrameIndex / fps;

  return (boneLeaf: string, out: Quaternion): Quaternion => {
    const tr = baseRotByBone.get(boneLeaf);
    if (tr === undefined) return restRot(boneLeaf, out);
    const v = sampleTrack(tr, refTime);
    return out.set(v[0], v[1], v[2], v[3]);
  };
}

/**
 * Subtract the base frame from translation and scale tracks only, in local
 * space, so a mesh-space gesture does not double up root translation or scale.
 *
 * @param clip The clip being baked, mutated in place.
 * @param opts Mesh bake options.
 * @param ctx Bake context.
 * @param fps Sample rate.
 */
function bakeLocalTranslationScaleOnly(
  clip: AnimationClip,
  opts: MeshBakeOptions,
  ctx: AdditiveBakeContext,
  fps: number,
): void {
  const baseClip =
    opts.basePoseType === 'anim_frame' && opts.basePoseClipName !== null
      ? ctx.clipsByName.get(opts.basePoseClipName)
      : clip;
  const baseByName = new Map<string, KeyframeTrack>();
  for (const t of baseClip?.tracks ?? []) baseByName.set(t.name, t);
  const refTime = opts.refFrameIndex / fps;

  for (const track of clip.tracks) {
    const { prop } = splitTrack(track.name);
    if (prop === 'quaternion') continue;
    const baseTrack = baseByName.get(track.name);
    if (baseTrack === undefined) continue;
    const baseVal = sampleTrack(baseTrack, refTime);
    const stride = track.getValueSize();
    const values = track.values;
    for (let i = 0; i < track.times.length; i += 1) {
      const off = i * stride;
      for (let c = 0; c < stride; c += 1) values[off + c] -= baseVal[c];
    }
  }
}

/**
 * `mesh` (Unreal `AAT_RotationOffsetMeshSpace`): rotation deltas are computed
 * in MESH (component) space rather than each bone's local parent space, then
 * stored back as a local-space delta clip the mixer can play. Translation stays
 * local. Mirrors Unreal's `GetBonePose_AdditiveMeshRotationOnly`.
 *
 * For each rotation track at time t:
 *
 * ```text
 * meshTarget = parentMeshRot * localTarget   (walk up the hierarchy)
 * meshBase   = parentMeshRot * localBase
 * meshDelta  = meshBase^-1 * meshTarget      (delta in mesh space)
 * localDelta = meshDelta                     (stored as a local additive)
 * ```
 *
 * @param clip The clip being baked, mutated in place.
 * @param opts Mesh bake options.
 * @param ctx Bake context; needs both `boneParents` and `restPose`.
 * @param fps Sample rate.
 */
function bakeMeshSpaceAdditive(
  clip: AnimationClip,
  opts: MeshBakeOptions,
  ctx: AdditiveBakeContext,
  fps: number,
): void {
  if (ctx.boneParents === undefined || ctx.restPose === undefined) {
    throw new Error(
      `[additiveBake] clip "${clip.name}" uses additive_type=mesh but the skeleton hierarchy was not provided`,
    );
  }
  // Re-bound as non-optional consts: TypeScript hoists the function
  // declarations below, so a narrowed `ctx.boneParents` would not be visible
  // inside them.
  const boneParents: ReadonlyMap<string, string> = ctx.boneParents;
  const restPose: RestPose = ctx.restPose;

  const baseProvider = makeBaseRotationProvider(clip, opts, ctx, fps);

  const rotTrackByBone = new Map<string, KeyframeTrack>();
  for (const track of clip.tracks) {
    const { node, prop } = splitTrack(track.name);
    if (prop === 'quaternion') rotTrackByBone.set(leafOf(node), track);
  }

  const scratch = new Quaternion();
  const accum = new Quaternion();
  const meshTarget = new Quaternion();
  const meshBase = new Quaternion();
  const chain: string[] = [];

  /**
   * The bone's local target rotation at a time, falling back to its rest.
   *
   * @param boneLeaf Bone leaf name.
   * @param time Time in seconds.
   * @param out Quaternion written in place.
   *
   * @returns `out`.
   */
  function localTargetRot(boneLeaf: string, time: number, out: Quaternion): Quaternion {
    const tr = rotTrackByBone.get(boneLeaf);
    if (tr !== undefined) {
      const v = sampleTrack(tr, time);
      return out.set(v[0], v[1], v[2], v[3]);
    }
    const rest = restPose.get(boneLeaf);
    if (rest === undefined) return out.set(0, 0, 0, 1);
    return out.set(rest.quaternion[0], rest.quaternion[1], rest.quaternion[2], rest.quaternion[3]);
  }

  /**
   * Mesh-space rotation of a bone: the product of local rotations from the root
   * down to the bone.
   *
   * @param boneLeaf Bone leaf name.
   * @param time Time in seconds.
   * @param source Local rotation source.
   * @param out Quaternion written in place.
   *
   * @returns `out`.
   */
  function meshRotAt(
    boneLeaf: string,
    time: number,
    source: (bone: string, t: number, o: Quaternion) => Quaternion,
    out: Quaternion,
  ): Quaternion {
    chain.length = 0;
    let cur: string | undefined = boneLeaf;
    while (cur !== undefined) {
      chain.push(cur);
      cur = boneParents.get(cur);
    }
    out.set(0, 0, 0, 1);
    for (let i = chain.length - 1; i >= 0; i -= 1) {
      out.multiply(source(chain[i], time, scratch));
    }
    return out;
  }

  for (const track of clip.tracks) {
    const { node, prop } = splitTrack(track.name);
    if (prop !== 'quaternion') continue; // translation / scale stay local
    const leaf = leafOf(node);
    const times = track.times;
    const values = track.values;
    for (let i = 0; i < times.length; i += 1) {
      const t = times[i];
      meshRotAt(leaf, t, localTargetRot, meshTarget);
      meshRotAt(leaf, t, (bone, _time, o) => baseProvider(bone, o), meshBase);
      accum.copy(meshBase).invert().multiply(meshTarget);
      const off = i * 4;
      values[off] = accum.x;
      values[off + 1] = accum.y;
      values[off + 2] = accum.z;
      values[off + 3] = accum.w;
    }
  }

  bakeLocalTranslationScaleOnly(clip, opts, ctx, fps);
}

/**
 * Bake `clip` into an additive delta IN PLACE, per the resolved settings.
 *
 * @param clip The clip, mutated in place.
 * @param settings The authored additive settings, or null for the historical
 *   local-space / own-frame-0 default.
 * @param ctx What the bake may read; see {@link AdditiveBakeContext}.
 */
export function bakeAdditive(
  clip: AnimationClip,
  settings: AdditiveSettings | null,
  ctx: AdditiveBakeContext,
): void {
  const resolved = resolveAdditiveSettings(settings);
  const fps = ctx.fps ?? DEFAULT_FPS;
  const { additiveType, basePoseType, basePoseClipName, refFrameIndex } = resolved;

  if (additiveType === 'mesh') {
    bakeMeshSpaceAdditive(clip, { basePoseType, basePoseClipName, refFrameIndex }, ctx, fps);
    return;
  }

  switch (basePoseType) {
    case 'local_frame':
      AnimationUtils.makeClipAdditive(clip, refFrameIndex, clip, fps);
      return;

    case 'anim_frame': {
      const base = basePoseClipName === null ? undefined : ctx.clipsByName.get(basePoseClipName);
      if (base === undefined) {
        throw new Error(
          `[additiveBake] clip "${clip.name}" uses base_pose_type=anim_frame but base pose clip "${String(basePoseClipName)}" was not found among loaded clips`,
        );
      }
      AnimationUtils.makeClipAdditive(clip, refFrameIndex, base, fps);
      return;
    }

    case 'ref_pose': {
      if (ctx.restPose === undefined) {
        throw new Error(
          `[additiveBake] clip "${clip.name}" uses base_pose_type=ref_pose but no rest pose was provided`,
        );
      }
      const refClip = referenceClipFromRestPose(clip, ctx.restPose);
      AnimationUtils.makeClipAdditive(clip, 0, refClip, fps);
      return;
    }

    case 'anim_scaled': {
      const base = basePoseClipName === null ? undefined : ctx.clipsByName.get(basePoseClipName);
      if (base === undefined) {
        throw new Error(
          `[additiveBake] clip "${clip.name}" uses base_pose_type=anim_scaled but base pose clip "${String(basePoseClipName)}" was not found among loaded clips`,
        );
      }
      bakeAnimScaledAdditive(clip, base);
      return;
    }

    default:
      AnimationUtils.makeClipAdditive(clip, refFrameIndex, clip, fps);
  }
}
