/**
 * `gameable/animation` — the layered animator.
 *
 * Body base layer, additive gesture layer, ARKit face layer and the
 * procedurals, plus the pure clip utilities the offline tools share.
 */

/**
 * Package identity marker for `gameable/animation`.
 *
 * @example
 * ```ts
 * import { PACKAGE } from 'gameable/animation';
 *
 * console.log(PACKAGE); // 'gameable/animation'
 * ```
 */
export const PACKAGE = '@gameable/animation' as const;

/**
 * The layered animator. `createAnimator` binds a skinned rig root to a mixer,
 * a gesture channel, a face blender and the procedurals; `update` advances all
 * four layers and refreshes `bodyPose`, `expression`, `jointOverrides` and
 * `gaze` in place. `update(dt)` also IS the clock: gestures, face clips and
 * blink run off the accumulated `dt` unless `clock` is passed, so pause, slow
 * motion and fixed-`dt` replay all behave.
 *
 * @example
 * ```ts
 * import { createAnimator } from 'gameable/animation';
 *
 * const animator = createAnimator({
 *   root: rigRoot,
 *   expressionSpace: { kind: 'arkit52', dim: 52 },
 * });
 * animator.addClip('idle', idleClip);
 * animator.setState({ velocity: [0, 0, 0], grounded: true, lookAt: null });
 * animator.update(1 / 60, { camera });
 * console.log(animator.bodyPose.bones.length); // boneCount * 4
 * ```
 */
export {
  createAnimator,
  HEAD_AIM_DEFAULTS,
  type AddClipOptions,
  type Animator,
  type AnimatorOptions,
  type AnimatorUpdateContext,
  type BodyPose,
  type ExpressionSpace,
  type HeadAimConfig,
  type SkeletonNames,
} from './Animator';

/**
 * The per-frame character state the guest sends, and its validator.
 * `validateCharacterState` throws a `TypeError` naming the first bad field, so
 * a NaN velocity is caught at the boundary instead of turning the skeleton into
 * NaN quaternions ten layers later.
 *
 * @example
 * ```ts
 * import { planarSpeed, validateCharacterState } from 'gameable/animation';
 *
 * const state = validateCharacterState({ velocity: [1, 0, 0], grounded: true });
 * console.log(planarSpeed(state)); // 1
 * ```
 */
export {
  IDLE_CHARACTER_STATE,
  planarSpeed,
  validateCharacterState,
  type CharacterClipRequest,
  type CharacterState,
} from './state/characterState';

/**
 * The speed-matched 1D locomotion blend and the `locomotion.json` index type
 * that `tools/retarget_locomotion.mjs` emits.
 *
 * @example
 * ```ts
 * import { blendLocomotion, createLocomotionBlend, sortLocomotionClips } from 'gameable/animation';
 *
 * const sorted = sortLocomotionClips({
 *   clips: [
 *     { name: 'idle', file: 'idle.glb', loop: true, speed: 0 },
 *     { name: 'walk', file: 'walk.glb', loop: true, speed: 1.4 },
 *   ],
 * });
 * const blend = blendLocomotion(sorted, 0.7, createLocomotionBlend());
 * console.log(blend.a, blend.b, blend.alpha); // 'idle' 'walk' 0.5
 * ```
 */
export {
  blendLocomotion,
  createLocomotionBlend,
  sortLocomotionClips,
  timeScaleFor,
  validateLocomotionIndex,
  writeLocomotionWeights,
  type LocomotionBlend,
  type LocomotionClipMeta,
  type LocomotionIndex,
} from './locomotion';

/**
 * Clip preparation: prune tracks that cannot bind to a rig, bake Unreal-parity
 * additive deltas, and build a mixer clip from a generated bone-quaternion
 * payload.
 *
 * @example
 * ```ts
 * import { pruneBodyClipTracks } from 'gameable/animation';
 *
 * const clip = { tracks: [{ name: 'pelvis.scale' }, { name: 'pelvis.quaternion' }] };
 * const report = pruneBodyClipTracks(clip, new Set(['pelvis']));
 * console.log(report.bound); // 1 — pelvis.scale is always stripped
 * ```
 */
export {
  ACTIVE_KEY_THRESHOLD,
  pruneBodyClipTracks,
  type GeneratedMotionMarker,
  type PrunableClip,
  type PrunableTrack,
  type PruneOptions,
  type PruneReport,
} from './clips/pruneBodyClipTracks';

/**
 * Unreal-parity additive baking. Runs once at load time, never per frame —
 * exactly as Unreal bakes the delta at asset-build time rather than at the
 * ApplyAdditive node.
 *
 * @example
 * ```ts
 * import { bakeAdditive, buildRestPose } from 'gameable/animation';
 *
 * const restPose = buildRestPose(rigRoot);
 * bakeAdditive(waveClip, { additiveType: 'local', basePoseType: 'ref_pose' }, {
 *   clipsByName: new Map(),
 *   restPose,
 * });
 * ```
 */
export {
  bakeAdditive,
  buildBoneParents,
  buildRestPose,
  resolveAdditiveSettings,
  type AdditiveBakeContext,
  type AdditiveSettings,
  type AdditiveType,
  type BasePoseType,
  type ResolvedAdditiveSettings,
  type RestPose,
  type RestPoseEntry,
} from './clips/additiveBake';

/**
 * Build a mixer clip from a generated per-frame bone-quaternion payload, and
 * compute the world-metre root travel that must be committed when a travelling
 * clip ends.
 *
 * @example
 * ```ts
 * import { computeRootDelta } from 'gameable/animation';
 *
 * console.log(computeRootDelta({ frames: 2, root: [0, 1, 0, 1.5, 1, -2.5] })); // [1.5, -2.5]
 * ```
 */
export {
  buildBodyMotionClip,
  computeRootDelta,
  type BodyMotionTracks,
  type BuildBodyMotionClipOptions,
  type RootMode,
} from './clips/bodyMotionClip';

/**
 * The ARKit-52 channel order, shared by the face clips, the blink overlay and
 * every expression-space map.
 *
 * @example
 * ```ts
 * import { arkitIndex, ARKIT_COUNT } from 'gameable/animation';
 *
 * console.log(ARKIT_COUNT); // 52
 * console.log(arkitIndex('JawOpen')); // 17
 * ```
 */
export {
  ARKIT_COUNT,
  ARKIT_EYE_BLINK_LEFT,
  ARKIT_EYE_BLINK_RIGHT,
  ARKIT_NAMES,
  arkitIndex,
} from './face/arkitNames';

/**
 * The face-clip blender: per-frame ARKit weights, blended and interpolated
 * across the loop boundary.
 *
 * @example
 * ```ts
 * import { createFaceClipPlayer } from 'gameable/animation';
 *
 * const face = createFaceClipPlayer();
 * face.addFaceClip('smile', { fps: 30, frames: [{ blendshapeWeights: new Float32Array(52) }] });
 * console.log(face.hasClip('smile')); // true
 * ```
 */
export {
  createFaceClipPlayer,
  type FaceClipData,
  type FaceClipFrame,
  type FaceClipPlayer,
  type FaceClipPlayerOptions,
} from './face/faceClipPlayer';

/**
 * The one-slot additive gesture channel: fade in, hold, fade out, clear. Blend
 * mode, loop style and clamp flag are written once at the start of a gesture
 * and the blend mode is restored at the end, so a borrowed base clip is not
 * left additive.
 *
 * @example
 * ```ts
 * import { createGestureChannel } from 'gameable/animation';
 *
 * const gesture = createGestureChannel();
 * gesture.play('wave', { durationMs: 1500, peakWeight: 0.7 });
 * console.log(gesture.isActive()); // true
 * ```
 */
export {
  ADDITIVE_BLEND_MODE,
  createGestureChannel,
  LOOP_ONCE,
  type GestureActionLike,
  type GestureChannel,
  type GestureChannelOptions,
  type GestureOptions,
} from './gesture/gestureChannel';

/**
 * The procedural blink channel. One per character — a module singleton made
 * two characters share one blink phase.
 *
 * @example
 * ```ts
 * import { createBlinkRuntime } from 'gameable/animation';
 *
 * const blink = createBlinkRuntime({ random: () => 0 });
 * console.log(blink.config.closeMs); // 80
 * ```
 */
export {
  BLINK_DEFAULTS,
  createBlinkRuntime,
  type BlinkConfig,
  type BlinkRuntime,
  type BlinkRuntimeOptions,
} from './procedural/blinkRuntime';

/**
 * Pure head-aim math: clamp the look yaw RELATIVE to the body, not to world
 * +Z, so a walking character cannot reach body-yaw plus the neck limit.
 *
 * @example
 * ```ts
 * import { clampYawToBody } from 'gameable/animation';
 *
 * const maxYaw = Math.PI / 4;
 * // Body turned 90 degrees to walk, camera still near world +Z.
 * console.log(clampYawToBody(0, Math.PI / 2, maxYaw)); // -0.785… , not 0
 * ```
 */
export {
  approachAngle,
  clampPitch,
  clampYawToBody,
  normalizeAngle,
  pitchTo,
  yawTo,
} from './procedural/headAim';

/**
 * The body graph evaluator and the state machine, ported from the POC's
 * character runtime. `evaluateBody` turns a graph into clip weights;
 * `applyWeights` pushes them onto mixer actions.
 *
 * @example
 * ```ts
 * import { createGraphRuntime, evaluateBody } from 'gameable/animation';
 *
 * const rt = createGraphRuntime({ now: () => 0 });
 * const out = evaluateBody(
 *   {
 *     nodes: [
 *       { id: 'final', type: 'finalPose' },
 *       { id: 'c', type: 'playClip', data: { clipName: 'idle', loop: true } },
 *     ],
 *     edges: [{ source: 'c', target: 'final', targetHandle: 'in' }],
 *   },
 *   rt,
 * );
 * console.log(out.weights.get('idle')); // 1
 * ```
 */
export {
  createEvalAccumulator,
  createGraphRuntime,
  evaluateBody,
  type EvalAccumulator,
  type GraphRuntimeOptions,
  type NodeHandlers,
} from './graph/evalBody';

/**
 * Push evaluated clip weights onto mixer actions, stopping everything the base
 * layer is not driving.
 *
 * @example
 * ```ts
 * import { applyWeights } from 'gameable/animation';
 *
 * applyWeights(new Map([['idle', 0.8]]), null, null, actionsByName);
 * ```
 */
export { applyWeights, type LoopConstants, type WeightedActionLike } from './graph/applyWeights';

/**
 * The transition-rule evaluator and the state machine runtime.
 *
 * @example
 * ```ts
 * import { evaluateRule } from 'gameable/animation';
 *
 * const fired = evaluateRule(
 *   {
 *     nodes: [
 *       { id: 'ruleResult', type: 'ruleResult' },
 *       { id: 'v', type: 'varGet', data: { varName: 'ready' } },
 *     ],
 *     edges: [{ source: 'v', target: 'ruleResult', targetHandle: 'in' }],
 *   },
 *   { variables: new Map([['ready', true]]) },
 * );
 * console.log(fired); // true
 * ```
 */
export { evaluateRule, type RuleContext, type RuleGraph } from './graph/rules';

/**
 * The state machine node runtime: entry, rule-guarded transitions, and a 300 ms
 * crossfade.
 *
 * @example
 * ```ts
 * import { createSMState, SM_TRANSITION_MS } from 'gameable/animation';
 *
 * console.log(SM_TRANSITION_MS); // 300
 * console.log(createSMState().currentState); // null
 * ```
 */
export { createSMHandler, createSMState, SM_TRANSITION_MS } from './graph/sm';

/**
 * Graph data shapes and the unknown-safe field readers used to narrow them.
 * Graph JSON is authored content, so nothing in this package casts it — and it
 * is treated as IMMUTABLE once evaluated: `nodeList` and `edgeList` memoise
 * their narrowed arrays on the identity of the `data` object they came from, so
 * the frame path allocates nothing. Swap the whole graph to change it.
 *
 * @example
 * ```ts
 * import { nodeList, numField } from 'gameable/animation';
 *
 * console.log(numField({ alpha: 0.25 }, 'alpha', 0.5)); // 0.25
 * console.log(numField({}, 'alpha', 0.5)); // 0.5
 * const data = { innerNodes: [{ id: 'output', type: 'stateOutput' }] };
 * console.log(nodeList(data, 'innerNodes') === nodeList(data, 'innerNodes')); // true
 * ```
 */
export {
  edgeList,
  isTrue,
  nodeList,
  numField,
  strField,
  strList,
  type BodyGraph,
  type ClipTiming,
  type GraphEdge,
  type GraphNode,
  type GraphNodeData,
  type GraphRuntime,
  type SMState,
  type SMTransition,
  type StickyRandom,
} from './graph/types';

/**
 * Navmesh path following, modelled on Unreal's `MoveTo*`. three-free, so it
 * unit-tests against a fake transform. The `onMoveCompleted` payload is pooled
 * per component: read it inside the sink, copy what you keep.
 *
 * @example
 * ```ts
 * import { createMovementComponent } from 'gameable/animation';
 *
 * const movement = createMovementComponent({ config: { maxSpeed: 2 } });
 * console.log(movement.status); // 'idle'
 * ```
 */
export {
  createMovementComponent,
  MovementComponent,
  type MoveCompletedEvent,
  type MovementConfig,
  type MovementEventSink,
  type MovementGroupLike,
  type MovementOptions,
  type MovementStatus,
  type MovementTarget,
  type NavMeshLike,
  type Vec3,
} from './movement/movementComponent';

/**
 * The retargeting math shared with `tools/retarget_locomotion.mjs`: bone-name
 * mapping, the rest-frame rotation rebind, and hip-height scaling.
 *
 * @example
 * ```ts
 * import { mapTrackName } from 'gameable/animation';
 *
 * const map = new Map([['mixamorig:Hips', 'pelvis']]);
 * console.log(mapTrackName('mixamorig:Hips.quaternion', map)); // 'pelvis.quaternion'
 * ```
 */
export {
  boneMapFromJson,
  hipHeightRatio,
  IDENTITY_QUAT,
  mapTrackName,
  quatInvert,
  quatMultiply,
  rebindLocalRotation,
  rebindQuaternionTrack,
  scalePositionTrack,
  type BoneNameMap,
  type Quat,
  type RestFrames,
} from './retarget';

/**
 * The single time source. Every runtime in this package takes an injected
 * `now()` rather than mixing `performance.now()` with `Date.now()`. Inside the
 * animator the default is its own accumulated `dt`, not this wall clock; pass
 * `clock: defaultClock` to opt back in.
 *
 * @example
 * ```ts
 * import { defaultClock } from 'gameable/animation';
 *
 * console.log(typeof defaultClock()); // 'number'
 * ```
 */
export { defaultClock, type Clock } from './clock';

/**
 * Prepared service gestures retargeted through both skeletons' rest frames.
 * Only explicitly mapped joints animate; translation never moves interview feet.
 *
 * @example
 * ```ts
 * import { retargetStationaryGesture } from 'gameable/animation';
 * const rest = { names: ['arm'], parents: [-1], rotations: [[0, 0, 0, 1]] };
 * const clip = retargetStationaryGesture('wave', {
 *   fps: 30, frames: 2, bones: { arm: [0, 0, 0, 1, 0, 0, 0, 1] },
 * }, rest, rest, { arm: 'arm' });
 * console.log(clip.tracks.length); // 1
 * ```
 */
export {
  retargetStationaryGesture,
  type PreparedMotion,
  type RestSkeleton,
} from './preparedGesture';

/**
 * Offline full-body locomotion preparation, independent of the motion provider.
 * Rebind rotations with rebindQuaternionTrack before closing loops and correcting contacts.
 *
 * @example
 * ```ts
 * import { stationaryRootTrack, closePositionLoop } from 'gameable/animation';
 * const positions = stationaryRootTrack([0.1, 0.05, 0.1], 0.9);
 * closePositionLoop(positions);
 * ```
 */
export {
  selectGaitCycle,
  closeQuaternionLoop,
  closePositionLoop,
  stationaryRootTrack,
  type LocomotionTake,
  type GaitCycleOptions,
} from './prepareLocomotion';
