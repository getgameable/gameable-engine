/**
 * Animator — the layered animator.
 *
 * Four layers, evaluated in this order every frame:
 *
 * 1. **body base** — an `AnimationMixer`. Weights come from the body graph when
 *    one is set, from `state.clips` when the guest drives clips explicitly, and
 *    otherwise from the speed-matched locomotion blend.
 * 2. **additive / gesture** — the one-slot {@link GestureChannel}, applied
 *    after the base weights and before `mixer.update`, so the base layer's
 *    per-frame weight reset cannot clobber the gesture envelope.
 * 3. **face** — face clips blended in ARKit-52 and mapped into the bundle's
 *    expression space, or the guest's own expression vector.
 * 4. **procedural** — blink into the ARKit blink channels, head aim into
 *    {@link Animator.jointOverrides}, and the residual aim out as gaze.
 *
 * `update` allocates nothing. Every buffer, map and scratch quaternion is
 * created in {@link createAnimator} and reused, the graph's indices are
 * memoised on the graph's identity, and the head aim parks itself when there is
 * nothing to look at.
 *
 * Time comes from `update(dt)`, not from the wall clock: gestures, face clips
 * and blink all run off the animator's own accumulated `dt` unless
 * {@link AnimatorOptions.clock} says otherwise, so pause, slow motion and
 * fixed-`dt` replay all behave.
 */
import {
  AdditiveAnimationBlendMode,
  type AnimationAction,
  type AnimationClip,
  AnimationMixer,
  type Bone,
  LoopOnce,
  LoopRepeat,
  type Object3D,
  Quaternion,
  type SkinnedMesh,
  Vector3,
} from 'three/webgpu';

import { type Clock } from './clock';
import { ARKIT_COUNT } from './face/arkitNames';
import {
  createFaceClipPlayer,
  type FaceClipData,
  type FaceClipPlayer,
} from './face/faceClipPlayer';
import { createGestureChannel, type GestureChannel } from './gesture/gestureChannel';
import { applyWeights } from './graph/applyWeights';
import {
  createEvalAccumulator,
  createGraphRuntime,
  evaluateBody,
  type EvalAccumulator,
} from './graph/evalBody';
import type { BodyGraph, GraphRuntime } from './graph/types';
import {
  blendLocomotion,
  createLocomotionBlend,
  type LocomotionBlend,
  type LocomotionClipMeta,
  type LocomotionIndex,
  sortLocomotionClips,
  writeLocomotionWeights,
} from './locomotion';
import {
  approachAngle,
  clampPitch,
  clampYawToBody,
  normalizeAngle,
  pitchTo,
  yawTo,
} from './procedural/headAim';
import { type BlinkConfig, createBlinkRuntime, type BlinkRuntime } from './procedural/blinkRuntime';
import { type CharacterState, IDLE_CHARACTER_STATE, planarSpeed } from './state/characterState';

/**
 * Which space the bundle's expression vector is in.
 *
 * Face clips are always authored in ARKit-52. A bundle whose head model is GNM
 * wants 383 (or the reduced 68) coefficients instead, so the mapping is a
 * BUNDLE field, not a code constant — two characters in one scene can be in
 * different spaces.
 */
export interface ExpressionSpace {
  /** The space. */
  kind: 'arkit52' | 'gnm' | 'gnm68';
  /** Number of channels in {@link Animator.expression}. */
  dim: number;
  /**
   * Convert ARKit-52 weights into this space.
   *
   * Required unless `kind` is `arkit52`. Must not allocate: it runs per frame.
   *
   * @param arkit 52 ARKit weights.
   * @param out `dim` channels, written in place.
   */
  map?: (arkit: Float32Array, out: Float32Array) => void;
}

/** Head-aim tuning. All angles are radians. */
export interface HeadAimConfig {
  /** Max head yaw away from the torso. */
  maxYaw: number;
  /** Max head pitch. */
  maxPitch: number;
  /** Max additional eye yaw, on top of the head's. */
  maxEyeYaw: number;
  /** Max additional eye pitch. */
  maxEyePitch: number;
  /** Follow rate in 1/seconds. */
  rate: number;
  /** Bone names that share the aim, and the fraction each takes. */
  joints: readonly (readonly [string, number])[];
  /**
   * How far toward the target the aimed joints turn, as a fraction of the look (1, the default:
   * all the way within `maxYaw` / `maxPitch`; 0.55 is the Gameable studio's "head as it is").
   * The eyes take what is left.
   */
  share?: number;
  /** How much of what is left the eyes take (1, the default: all of it within their range). */
  eyeShare?: number;
}

/** The default head-aim tuning: 45 degrees of yaw over neck_01, neck_02 and head. */
export const HEAD_AIM_DEFAULTS: Readonly<HeadAimConfig> = Object.freeze({
  maxYaw: (45 * Math.PI) / 180,
  maxPitch: (25 * Math.PI) / 180,
  maxEyeYaw: (35 * Math.PI) / 180,
  maxEyePitch: (20 * Math.PI) / 180,
  rate: 8,
  joints: Object.freeze([
    Object.freeze(['neck_01', 0.25]),
    Object.freeze(['neck_02', 0.25]),
    Object.freeze(['head', 0.5]),
  ]) as readonly (readonly [string, number])[],
});

/**
 * What this rig calls the two bones the animator addresses by name.
 *
 * The defaults are the UE-style names a GNM pack uses. A skinned body exported
 * from another authoring tool spells them differently — `aosrig_v0` has `root`
 * and `c_head` — and nothing else in the animator cares, so this is the whole
 * translation table.
 */
export interface SkeletonNames {
  /** The bone {@link BodyPose.rootPos} is read from. Defaults to `pelvis`. */
  root?: string;
  /** The bone head aim measures the look direction from. Defaults to `head`. */
  head?: string;
}

/** How a clip behaves once registered. */
export interface AddClipOptions {
  /**
   * Register the clip on the additive/gesture layer instead of the base layer.
   * Additive actions are never stopped by the base layer's weight pass.
   */
  additive?: boolean;
  /** Whether the clip loops; defaults to true. */
  loop?: boolean;
}

/** The final skeleton pose for this frame. */
export interface BodyPose {
  /** Per-bone local rotations, `xyzw`, in skeleton order. */
  bones: Float32Array;
  /** The root bone's local position. */
  rootPos: Float32Array;
}

/** What `update` needs from the rest of the frame. */
export interface AnimatorUpdateContext {
  /** Camera to look at when the state names no explicit `lookAt`. */
  camera?: Object3D | null;
  /** World point to look at; overrides both the state's `lookAt` and the camera. */
  lookAt?: readonly [number, number, number] | null;
  /**
   * The character's own facing, in radians about `+Y`, for the head-aim clamp.
   *
   * Without it the clamp reads `root.rotation.y`, which is right only when the
   * rig root itself carries the facing. A skinned body parented under the
   * entity's object inherits its yaw instead, and the root stays at zero — so
   * the host passes the entity's world yaw here.
   */
  bodyYaw?: number;
}

/** Options for {@link createAnimator}. */
export interface AnimatorOptions {
  /** The skinned rig root. Its skeleton defines the bone order of {@link BodyPose}. */
  root: Object3D;
  /**
   * Millisecond clock for the gesture, face and blink envelopes.
   *
   * Defaults to the animator's OWN accumulated `dt`: every `update(dt)` adds
   * `dt * 1000` to it, so pausing the engine pauses blinks and gestures,
   * `timeScale` slows them, and a replay at a fixed `dt` reproduces them
   * exactly. Pass `defaultClock` from this package to opt back into wall clock
   * (`performance.now()`) — appropriate only for an animator driven outside the
   * engine loop.
   */
  clock?: Clock;
  /** The bundle's expression space. */
  expressionSpace: ExpressionSpace;
  /** Locomotion clips, for the velocity-driven fallback. */
  locomotion?: LocomotionIndex;
  /** What this rig calls its root and head bones. */
  bones?: SkeletonNames;
  /** Head-aim tuning overrides. */
  headAim?: Partial<HeadAimConfig>;
  /** Blink tuning overrides, or false to disable the blink layer. */
  blink?: Partial<BlinkConfig> | false;
  /** Uniform `[0, 1)` source for blink scheduling and graph randoms. */
  random?: () => number;
}

/** The layered animator. */
export interface Animator {
  /** Bone names, in the order {@link BodyPose.bones} uses. */
  readonly boneNames: readonly string[];
  /** The final skeleton pose, including the procedural overrides. Reused per frame. */
  readonly bodyPose: BodyPose;
  /** The expression vector in the bundle's space. Reused per frame. */
  readonly expression: Float32Array;
  /**
   * Procedural joint rotations, by bone name.
   *
   * Each entry is a PARENT-LOCAL delta rotation (`xyzw`) that PRE-multiplies the
   * bone's animated local rotation. {@link Animator.bodyPose} already has them
   * applied; this map is for rig backends that take joint overrides separately
   * and must not have them applied twice.
   */
  readonly jointOverrides: ReadonlyMap<string, Float32Array>;
  /** Eye gaze as `[pitchL, yawL, pitchR, yawR]` in radians. Reused per frame. */
  readonly gaze: Float32Array;
  /**
   * The head aim's tuning, live: `share`, `eyeShare`, the limits and the rate may be changed
   * between frames. The joint list is fixed at creation.
   */
  readonly headAim: HeadAimConfig;
  /** The additive gesture layer. */
  readonly gesture: GestureChannel;
  /** The blink channel, or null when blink is disabled. */
  readonly blink: BlinkRuntime | null;
  /** The face-clip blender. */
  readonly face: FaceClipPlayer;
  /** Blueprint variables the body graph reads. */
  readonly variables: Map<string, unknown>;
  /**
   * Register a body clip.
   *
   * @param name Runtime name; how `state.clips` and the graph address it.
   * @param clip The clip, already bound to this rig's bone names.
   * @param options See {@link AddClipOptions}.
   */
  addClip(name: string, clip: AnimationClip, options?: AddClipOptions): void;
  /**
   * Register a face clip.
   *
   * @param name Runtime name.
   * @param clip ARKit-52 frames; see {@link FaceClipData}.
   */
  addFaceClip(name: string, clip: FaceClipData): void;
  /**
   * Set (or clear) the body graph.
   *
   * The graph is treated as IMMUTABLE from here on. Its node/edge indices, its
   * narrowed inner lists and every transition edge's rule graph are memoised on
   * the identity of the authored objects, so the per-frame path can allocate
   * nothing; editing a node array in place afterwards will not be seen. To
   * change a graph, build a new graph object and call this again — swapping is
   * free, and the caches are `WeakMap`s, so the old graph's entries go with it.
   *
   * @param graph The graph, or null to fall back to `state.clips` / locomotion.
   */
  setGraph(graph: BodyGraph | null): void;
  /**
   * Set the locomotion index used by the velocity fallback.
   *
   * @param index The index, or null to disable the fallback.
   */
  setLocomotion(index: LocomotionIndex | null): void;
  /**
   * Set the character state for the coming frames.
   *
   * @param state The state; validate untrusted input with `validateCharacterState`.
   */
  setState(state: CharacterState): void;
  /**
   * Advance every layer by `dt`.
   *
   * @param dt Seconds since the last update.
   * @param context See {@link AnimatorUpdateContext}.
   */
  update(dt: number, context?: AnimatorUpdateContext): void;
  /** Release the mixer, the actions and the clip caches. */
  dispose(): void;
}

/**
 * Collect the rig's bones.
 *
 * Prefers the first `SkinnedMesh`'s skeleton, because that order is the one the
 * lift shader and the rig backends index by. Falls back to traversal order for
 * a bones-only rig, which is what a synthetic test skeleton is.
 *
 * @param root The rig root.
 *
 * @returns The bones, in skeleton order.
 */
function collectBones(root: Object3D): Bone[] {
  const skinned: SkinnedMesh[] = [];
  root.traverse((n) => {
    if ((n as Partial<SkinnedMesh>).isSkinnedMesh === true) skinned.push(n as SkinnedMesh);
  });
  if (skinned.length > 0) return [...skinned[0].skeleton.bones];
  const bones: Bone[] = [];
  root.traverse((n) => {
    if ((n as Partial<Bone>).isBone === true) bones.push(n as Bone);
  });
  return bones;
}

/** The character's up axis, for the yaw half of the head aim. */
const UP = new Vector3(0, 1, 0);

/**
 * The character's right axis, for the pitch half of the head aim.
 *
 * A POSITIVE rotation about +X tips the +Z forward vector DOWN, so the pitch
 * angle is negated when it is turned into a rotation — the sign mistake that
 * made the POC's first head-aim look at the floor when the camera was above.
 */
const RIGHT = new Vector3(1, 0, 0);

/**
 * How small the summed head and eye aim must be before the aim parks itself.
 *
 * `approachAngle` is exponential, so an aim released from its clamp never
 * reaches exactly zero; this is the point where it is below a ten-thousandth of
 * a degree and is indistinguishable from identity in the pose.
 */
const AIM_PARK_EPSILON = 1e-5;

/**
 * Create a layered animator.
 *
 * @param options See {@link AnimatorOptions}.
 *
 * @returns The {@link Animator}.
 */
export function createAnimator(options: AnimatorOptions): Animator {
  /**
   * Simulated milliseconds, advanced by `update(dt)`.
   *
   * The gesture, face and blink runtimes all used to read `performance.now()`
   * directly, so a paused engine still blinked, slow motion did not slow a
   * gesture down, and a fixed-`dt` replay was not reproducible. They read this
   * instead unless the caller injects its own clock.
   */
  let elapsedMs = 0;
  const now: Clock = options.clock ?? ((): number => elapsedMs);
  const root = options.root;
  const space = options.expressionSpace;
  if (space.kind !== 'arkit52' && space.map === undefined) {
    throw new Error(
      `createAnimator: expressionSpace.kind "${space.kind}" needs a map(arkit, out) function`,
    );
  }

  const aim: HeadAimConfig = { ...HEAD_AIM_DEFAULTS, ...options.headAim };

  const rootBoneName = options.bones?.root ?? 'pelvis';
  const headBoneName = options.bones?.head ?? 'head';

  const bones = collectBones(root);
  const boneNames = bones.map((b) => b.name);
  // NOT clamped to 0: a rig whose root bone is spelled differently used to have
  // bone 0's position silently reported as the root translation, which reads as
  // a character standing in the wrong place with nothing in the log to explain
  // it. -1 means "this rig has no such bone" and `rootPos` is simply not written.
  const rootBoneIndex = boneNames.indexOf(rootBoneName);
  if (rootBoneIndex < 0 && bones.length > 0) {
    console.warn(
      `[animation] createAnimator: no bone named "${rootBoneName}" in this rig; ` +
        "bodyPose.rootPos stays at zero. Pass bones.root to name the rig's own root bone.",
    );
  }

  const mixer = new AnimationMixer(root);
  /** Every registered action, base and additive. */
  const actions = new Map<string, AnimationAction>();
  /** Base-layer actions only; the weight pass may stop these. */
  const baseActions = new Map<string, AnimationAction>();
  const registeredLoops = new Map<string, boolean>();
  const faceClipNames = new Set<string>();

  const face = createFaceClipPlayer({ now });
  const gesture = createGestureChannel({ now });
  const blink =
    options.blink === false
      ? null
      : createBlinkRuntime({ now, random: options.random, config: options.blink });

  const graphRuntime: GraphRuntime = createGraphRuntime({ now, rand: options.random });
  let graph: BodyGraph | null = null;
  const evalAcc: EvalAccumulator = createEvalAccumulator();

  let locomotionClips: LocomotionClipMeta[] = [];
  if (options.locomotion !== undefined) locomotionClips = sortLocomotionClips(options.locomotion);
  const locoBlend: LocomotionBlend = createLocomotionBlend();

  let state: CharacterState = IDLE_CHARACTER_STATE;

  // ── Preallocated per-frame storage ────────────────────────────────────────
  const bodyWeights = new Map<string, number>();
  const bodyLoop = new Map<string, boolean>();
  const bodySpeed = new Map<string, number>();
  const faceWeights = new Map<string, number>();
  const arkit = new Float32Array(ARKIT_COUNT);
  const expression = new Float32Array(space.dim);
  const bodyPose: BodyPose = {
    bones: new Float32Array(bones.length * 4),
    rootPos: new Float32Array(3),
  };
  const gaze = new Float32Array(4);
  const jointOverrides = new Map<string, Float32Array>();
  for (const [jointName] of aim.joints)
    jointOverrides.set(jointName, new Float32Array([0, 0, 0, 1]));
  /**
   * The override buffer for each bone, in skeleton order, or null.
   *
   * `jointOverrides` is complete at construction and never gains a key, so the
   * per-bone `Map.get(bone.name)` in {@link readBodyPose} — 114 string-keyed
   * hash lookups per frame on a full body — is resolved into a parallel array
   * once, here.
   */
  const overrideByBone: (Float32Array | null)[] = bones.map(
    (b) => jointOverrides.get(b.name) ?? null,
  );
  /** The aimed overrides in `aim.joints` order, for the settle-to-identity pass. */
  const aimedOverrides: Float32Array[] = [];
  for (const [jointName] of aim.joints) {
    const out = jointOverrides.get(jointName);
    if (out !== undefined) aimedOverrides.push(out);
  }

  const scratchTarget = new Vector3();
  const scratchHead = new Vector3();
  const rootWorldQ = new Quaternion();
  const parentWorldQ = new Quaternion();
  const relFrameQ = new Quaternion();
  const aimQ = new Quaternion();
  const deltaQ = new Quaternion();
  const boneQ = new Quaternion();

  let aimYaw = 0;
  let aimPitch = 0;
  let residualYaw = 0;
  let residualPitch = 0;
  /**
   * Whether the aim is parked: no target, converged, overrides already identity.
   *
   * While this is set, {@link updateHeadAim} returns immediately. It is cleared
   * the moment a look target or a camera fallback appears, so the very next
   * frame runs the full transport again.
   */
  let aimParked = false;

  /**
   * Memoised `getObjectByName` results for the bones head aim addresses.
   *
   * `getObjectByName` is a full depth-first walk of the subtree. Head aim wants
   * the head bone plus one bone per aimed joint, every frame — on a 114-bone
   * body that was the only graph traversal left in `update`, four times over.
   * Only hits are remembered, so a name that is not in the rig yet is looked up
   * again next frame rather than being cached as permanently absent.
   */
  const boneCache = new Map<string, Object3D>();

  /**
   * The bone with this name under the root, remembered once found.
   *
   * @param name The bone name.
   *
   * @returns The bone, or undefined when the rig has no such bone.
   */
  function findBone(name: string): Object3D | undefined {
    const cached = boneCache.get(name);
    if (cached !== undefined) return cached;
    const found = root.getObjectByName(name);
    if (found !== undefined) boneCache.set(name, found);
    return found;
  }

  /**
   * Fill the base-layer weight maps from the guest's explicit clip drives, and
   * split face-clip names off into the face layer.
   */
  function weightsFromStateClips(): void {
    // The caller has already checked `state.clips` is a non-empty array; the
    // old `?? []` fallback allocated an array on a path that cannot be reached.
    const clips = state.clips;
    if (clips === undefined) return;
    for (const c of clips) {
      if (faceClipNames.has(c.name)) {
        faceWeights.set(c.name, c.weight);
        continue;
      }
      bodyWeights.set(c.name, c.weight);
      bodyLoop.set(c.name, registeredLoops.get(c.name) ?? true);
      if (c.time !== undefined) {
        const action = baseActions.get(c.name);
        if (action !== undefined) action.time = c.time;
      }
    }
  }

  /**
   * Refresh `graphRuntime.clipTimings` from the running base actions.
   *
   * The `ruleAnimTimeRemaining` / `ruleAnimTimeRatio` transition rules read
   * this. The POC took it from a global `debugState` the render loop happened
   * to populate; if that loop was not running, every such rule silently read
   * its "999 seconds remaining" default and no state machine ever advanced.
   * Entries are mutated in place so the refresh allocates nothing.
   */
  function updateClipTimings(): void {
    for (const [name, action] of baseActions) {
      const duration = action.getClip().duration;
      if (duration <= 0) continue;
      const time = action.time;
      let entry = graphRuntime.clipTimings.get(name);
      if (entry === undefined) {
        entry = { time: 0, duration: 0, remaining: 0, ratio: 0 };
        graphRuntime.clipTimings.set(name, entry);
      }
      entry.time = time;
      entry.duration = duration;
      entry.remaining = duration - time;
      entry.ratio = time / duration;
    }
  }

  /**
   * Fill the base-layer weight maps from the body graph.
   */
  function weightsFromGraph(): void {
    if (graph === null) return;
    updateClipTimings();
    evaluateBody(graph, graphRuntime, evalAcc);
    for (const [name, w] of evalAcc.weights) bodyWeights.set(name, w);
    for (const [name, l] of evalAcc.loop) bodyLoop.set(name, l);
    for (const [name, s] of evalAcc.speed) bodySpeed.set(name, s);
  }

  /**
   * Compose the ARKit-52 vector and map it into the bundle's expression space.
   */
  function updateFace(): void {
    const driven = face.getBlendedWeights(faceWeights.size > 0 ? faceWeights : null);
    if (driven !== null) arkit.set(driven);
    else arkit.fill(0);

    const guest = state.expression;
    // A 52-long vector is ARKit and joins the composition; a dim-long one is
    // already in the bundle's space and bypasses it.
    const guestIsArkit = guest !== undefined && guest.length === ARKIT_COUNT;
    if (guestIsArkit) arkit.set(guest.subarray(0, ARKIT_COUNT));

    // The bypass is checked BEFORE the blink: `applyToArkit` advances the blink
    // scheduler, and advancing it on a frame whose result is thrown away made
    // the blink phase depend on whether the guest happened to be driving the
    // face in bundle space.
    if (guest !== undefined && !guestIsArkit) {
      expression.set(guest.subarray(0, Math.min(guest.length, expression.length)));
      return;
    }

    blink?.applyToArkit(arkit, 1);

    if (space.map === undefined) expression.set(arkit.subarray(0, expression.length));
    else space.map(arkit, expression);
  }

  /**
   * Resolve the look target for this frame.
   *
   * @param context The update context.
   *
   * @returns Whether a target was found; the point is left in `scratchTarget`.
   */
  function resolveLookTarget(context: AnimatorUpdateContext | undefined): boolean {
    const explicit = context?.lookAt ?? state.lookAt ?? null;
    if (explicit !== null) {
      scratchTarget.set(explicit[0], explicit[1], explicit[2]);
      return true;
    }
    const camera = context?.camera;
    if (camera !== undefined && camera !== null) {
      camera.getWorldPosition(scratchTarget);
      return true;
    }
    return false;
  }

  /**
   * Advance the head aim and write the joint overrides and the gaze vector.
   *
   * @param dt Seconds since the last update.
   * @param context The update context.
   */
  function updateHeadAim(dt: number, context: AnimatorUpdateContext | undefined): void {
    // Early-out: an idle character with nothing to look at ran the whole
    // quaternion transport — a world-quaternion read per aimed joint plus four
    // multiplies — every frame to write the identity it already held. Only
    // skipped once the aim has actually decayed to nothing, so releasing a look
    // target still plays the decay out (Animator.test.ts covers exactly that).
    const wantsAim =
      (context?.lookAt ?? state.lookAt ?? null) !== null ||
      (context?.camera !== undefined && context.camera !== null);
    if (!wantsAim) {
      const residual =
        Math.abs(aimYaw) + Math.abs(aimPitch) + Math.abs(residualYaw) + Math.abs(residualPitch);
      if (residual < AIM_PARK_EPSILON) {
        if (aimParked) return;
        // Settle exactly once on the way in, so the parked frames are reading a
        // pose that is identity rather than "nearly identity".
        aimYaw = 0;
        aimPitch = 0;
        residualYaw = 0;
        residualPitch = 0;
        gaze.fill(0);
        for (const out of aimedOverrides) {
          out[0] = 0;
          out[1] = 0;
          out[2] = 0;
          out[3] = 1;
        }
        aimParked = true;
        return;
      }
    }
    aimParked = false;

    const headBone = findBone(headBoneName) ?? root;
    let targetYaw = 0;
    let targetPitch = 0;
    let rawRelYaw = 0;
    let rawPitch = 0;

    if (resolveLookTarget(context)) {
      headBone.getWorldPosition(scratchHead);
      const dx = scratchTarget.x - scratchHead.x;
      const dy = scratchTarget.y - scratchHead.y;
      const dz = scratchTarget.z - scratchHead.z;
      const bodyYaw = context?.bodyYaw ?? root.rotation.y;
      rawRelYaw = normalizeAngle(yawTo(dx, dz) - bodyYaw);
      rawPitch = pitchTo(dx, dy, dz);
      const share = aim.share ?? 1;
      targetYaw =
        share === 1
          ? clampYawToBody(yawTo(dx, dz), bodyYaw, aim.maxYaw)
          : Math.max(-aim.maxYaw, Math.min(aim.maxYaw, share * rawRelYaw));
      targetPitch = clampPitch(share * rawPitch, aim.maxPitch);
    }

    aimYaw = approachAngle(aimYaw, targetYaw, aim.rate, dt);
    aimPitch = approachAngle(aimPitch, targetPitch, aim.rate, dt);

    // The eyes take whatever the neck could not, clamped to their own range.
    const eyeShare = aim.eyeShare ?? 1;
    residualYaw = approachAngle(
      residualYaw,
      Math.max(-aim.maxEyeYaw, Math.min(aim.maxEyeYaw, eyeShare * (rawRelYaw - targetYaw))),
      aim.rate,
      dt,
    );
    residualPitch = approachAngle(
      residualPitch,
      Math.max(-aim.maxEyePitch, Math.min(aim.maxEyePitch, eyeShare * (rawPitch - targetPitch))),
      aim.rate,
      dt,
    );
    gaze[0] = residualPitch;
    gaze[1] = residualYaw;
    gaze[2] = residualPitch;
    gaze[3] = residualYaw;

    root.getWorldQuaternion(rootWorldQ);
    rootWorldQ.invert();

    for (const [jointName, share] of aim.joints) {
      const out = jointOverrides.get(jointName);
      if (out === undefined) continue;
      const bone = findBone(jointName);
      if (bone === undefined) {
        out[0] = 0;
        out[1] = 0;
        out[2] = 0;
        out[3] = 1;
        continue;
      }
      // The aim is authored in the character's own frame; transport it into the
      // bone's PARENT frame so it pre-multiplies the animated local rotation.
      // `relFrame` is the parent's orientation relative to the character root.
      const parent = bone.parent;
      if (parent === null) parentWorldQ.identity();
      else parent.getWorldQuaternion(parentWorldQ);
      relFrameQ.copy(rootWorldQ).multiply(parentWorldQ);

      aimQ.setFromAxisAngle(UP, aimYaw * share);
      deltaQ.setFromAxisAngle(RIGHT, -aimPitch * share);
      aimQ.multiply(deltaQ);

      deltaQ.copy(relFrameQ).invert().multiply(aimQ).multiply(relFrameQ);
      out[0] = deltaQ.x;
      out[1] = deltaQ.y;
      out[2] = deltaQ.z;
      out[3] = deltaQ.w;
    }
  }

  /**
   * Read the posed skeleton into {@link BodyPose}, folding in the overrides.
   */
  function readBodyPose(): void {
    const out = bodyPose.bones;
    for (let i = 0; i < bones.length; i += 1) {
      const bone = bones[i];
      const override = overrideByBone[i];
      const o = i * 4;
      if (override === null) {
        out[o] = bone.quaternion.x;
        out[o + 1] = bone.quaternion.y;
        out[o + 2] = bone.quaternion.z;
        out[o + 3] = bone.quaternion.w;
      } else {
        deltaQ.set(override[0], override[1], override[2], override[3]);
        boneQ.copy(deltaQ).multiply(bone.quaternion);
        out[o] = boneQ.x;
        out[o + 1] = boneQ.y;
        out[o + 2] = boneQ.z;
        out[o + 3] = boneQ.w;
      }
    }
    if (rootBoneIndex >= 0) {
      const rootBone = bones[rootBoneIndex];
      bodyPose.rootPos[0] = rootBone.position.x;
      bodyPose.rootPos[1] = rootBone.position.y;
      bodyPose.rootPos[2] = rootBone.position.z;
    }
  }

  return {
    boneNames,
    bodyPose,
    expression,
    jointOverrides,
    gaze,
    headAim: aim,
    gesture,
    blink,
    face,
    variables: graphRuntime.variables,

    addClip(name: string, clip: AnimationClip, clipOptions: AddClipOptions = {}): void {
      const action = mixer.clipAction(clip);
      action.setLoop(clipOptions.loop === false ? LoopOnce : LoopRepeat, Infinity);
      action.setEffectiveWeight(0);
      if (clipOptions.additive === true) action.blendMode = AdditiveAnimationBlendMode;
      actions.set(name, action);
      registeredLoops.set(name, clipOptions.loop !== false);
      if (clipOptions.additive !== true) baseActions.set(name, action);
    },

    addFaceClip(name: string, clip: FaceClipData): void {
      face.addFaceClip(name, clip);
      faceClipNames.add(name);
    },

    setGraph(next: BodyGraph | null): void {
      graph = next;
    },

    setLocomotion(index: LocomotionIndex | null): void {
      locomotionClips = index === null ? [] : sortLocomotionClips(index);
    },

    setState(next: CharacterState): void {
      state = next;
    },

    update(dt: number, context?: AnimatorUpdateContext): void {
      // The envelope clock advances first, so everything this frame — graph
      // transitions, gesture fades, face-clip cursors, blink — reads one
      // consistent time, and it is the caller's `dt`, not wall clock.
      elapsedMs += dt * 1000;

      bodyWeights.clear();
      bodyLoop.clear();
      bodySpeed.clear();
      faceWeights.clear();

      // 1. body base
      if (graph !== null) {
        weightsFromGraph();
      } else if (state.clips !== undefined && state.clips.length > 0) {
        weightsFromStateClips();
      } else if (locomotionClips.length > 0) {
        blendLocomotion(locomotionClips, planarSpeed(state), locoBlend);
        writeLocomotionWeights(locoBlend, bodyWeights, bodySpeed);
      }
      applyWeights(bodyWeights, bodyLoop, bodySpeed, baseActions, {
        loopRepeat: LoopRepeat,
        loopOnce: LoopOnce,
      });

      // 2. additive / gesture — before mixer.update, after the base weights.
      gesture.apply(actions);

      mixer.update(dt);

      // 3. face and 4. procedural
      updateFace();
      updateHeadAim(dt, context);
      readBodyPose();
    },

    dispose(): void {
      mixer.stopAllAction();
      for (const action of actions.values()) {
        mixer.uncacheAction(action.getClip(), action.getRoot());
        mixer.uncacheClip(action.getClip());
      }
      mixer.uncacheRoot(root);
      actions.clear();
      baseActions.clear();
      registeredLoops.clear();
      faceClipNames.clear();
      boneCache.clear();
      face.reset();
      gesture.stop();
    },
  };
}
