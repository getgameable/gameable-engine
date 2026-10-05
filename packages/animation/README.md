# gameable/animation

## What

The animation stack, as four layers evaluated in order: a body base layer (an
`AnimationMixer` driven by a blueprint graph, by explicit clip weights, or by a
speed-matched locomotion blend), an additive/gesture layer, a face layer in
ARKit-52 or the bundle's expression space, and procedural blink, head aim and
gaze. Plus the pure clip utilities the offline tools share: track pruning,
Unreal-parity additive baking, and locomotion retargeting.

`update(dt)` allocates nothing. Every buffer, map and scratch quaternion is
created once in `createAnimator`, the graph's indices are memoised on the
graph's identity, and the head aim parks itself when there is nothing to look
at. Time comes from `dt`, not from the wall clock.

## When to use

You are animating a character or a skinned placeholder, or retargeting
locomotion clips onto the canonical armature.

## Install

```sh
npm install gameable
```

Inside this repository the package is a workspace member and needs no install.

## Minimal example

```ts
import { createAnimator, validateCharacterState } from 'gameable/animation';

const animator = createAnimator({
  root: rigRoot, // the skinned rig root
  expressionSpace: { kind: 'arkit52', dim: 52 },
  locomotion: locomotionIndex, // parsed locomotion.json
});

animator.addClip('idle', idleClip);
animator.addClip('walk', walkClip);
animator.addFaceClip('smile', smileClipJson);

// Each frame, from the guest's frame output:
animator.setState(validateCharacterState(frame.character));
animator.update(dt, { camera });

character.setBodyPose(animator.bodyPose);
character.setExpression(animator.expression);
character.setJointOverrides(animator.jointOverrides);
```

## API

- `createAnimator({ root, clock?, expressionSpace, locomotion?, headAim?, blink?, random? })`
  → `Animator`.
- `Animator`: `addClip(name, clip, { additive?, loop? })`, `addFaceClip(name, { fps, frames })`,
  `setGraph(graph)`, `setLocomotion(index)`, `setState(state)`, `update(dt, { camera?, lookAt? })`,
  `dispose()`.
- Outputs, all reused in place: `bodyPose.bones` (per-bone `xyzw` in skeleton
  order), `bodyPose.rootPos`, `expression`, `jointOverrides`, `gaze`
  (`[pitchL, yawL, pitchR, yawR]`), `boneNames`.
- Sub-runtimes, usable on their own: `createGestureChannel`, `createFaceClipPlayer`,
  `createBlinkRuntime`, `createMovementComponent`.
- State: `CharacterState { clips?, expression?, lookAt?, velocity, grounded }`,
  `validateCharacterState`, `planarSpeed`.
- Locomotion: `LocomotionIndex`, `sortLocomotionClips`, `blendLocomotion`,
  `writeLocomotionWeights`, `timeScaleFor`, `validateLocomotionIndex`.
- Graph: `evaluateBody`, `createGraphRuntime`, `applyWeights`, `evaluateRule`,
  `createSMHandler`.
- Clips: `pruneBodyClipTracks`, `bakeAdditive`, `buildRestPose`,
  `buildBoneParents`, `buildBodyMotionClip`, `computeRootDelta`.
- Retargeting: `mapTrackName`, `rebindQuaternionTrack`, `scalePositionTrack`,
  `hipHeightRatio`, `boneMapFromJson`; the offline driver is
  `tools/retarget_locomotion.mjs`.

Offline locomotion helpers are independent of the generation service:
`selectGaitCycle` searches an explicit frame window for a low-error loop and
matches duration to target speed and hip scale. `rebindQuaternionTrack` transforms
local rotations through source/target rest frames. `closeQuaternionLoop` and
`closePositionLoop` distribute seam corrections over a bounded tail.
`stationaryRootTrack` removes horizontal root travel, corrects FK foot heights to
a contact plane, and optionally preserves source running flight. Inputs are
validated; use these at asset preparation time, never inside a frame loop.
Keep prompts, bone maps, take selection, checksums and art-direction adjustments
in the consuming project. These helpers do not contact Kimodo or write asset files.

## Gotchas

- Face clips are ARKit-52 weights; the bundle's expression space may be GNM. The
  map is a bundle field, not a code constant, so `expressionSpace.kind` other
  than `arkit52` must carry a `map(arkit, out)` — `createAnimator` throws
  otherwise.
- `state.expression` is read as ARKit-52 when it is 52 long and as the bundle's
  own space otherwise. Only the ARKit path composes with the procedural blink;
  a vector already in bundle space bypasses it.
- `bodyPose` is the FINAL pose and already has the procedural joint overrides
  folded in. `jointOverrides` exposes the same rotations separately, for rig
  backends that take them as their own input — apply one or the other, never
  both.
- `jointOverrides` entries are PARENT-LOCAL deltas that pre-multiply the bone's
  animated rotation, not absolute orientations.
- Head aim clamps yaw relative to the BODY, not to world +Z. Clamping against
  world forward lets a walking character's head reach body-yaw plus the neck
  limit, which is the "exorcist twist" the POC shipped with for a while.
- **A graph handed to `setGraph` is immutable.** Its node and edge indices, the
  narrowed inner lists of every state, and each transition edge's rule graph are
  memoised on the identity of the authored objects, which is what makes the
  frame path allocation-free. Editing a node array in place is not re-read.
  Build a new graph object (fresh arrays — what parsing the JSON again gives
  you) and call `setGraph` with it; that is free, and the caches are `WeakMap`s
  so the old graph's entries go with it.
- The gesture layer is one slot. Registering a gesture clip with
  `{ additive: true }` keeps the base layer's weight pass from stopping it; a
  gesture clip registered without it will be zeroed every frame.
- The gesture channel writes an action's blend mode, loop style and clamp flag
  ONCE, when the gesture reaches it, and puts the blend mode back when the
  envelope ends. Only the weight is written per frame — `setLoop` on a running
  action resets its loop counter.
- `bones.root` must name a bone this rig actually has. A rig with no bone by
  that name logs one warning at construction and leaves `bodyPose.rootPos` at
  zero; it does not quietly report bone 0's position instead.
- `gesture.setExclusiveOverride(true)` while a full-body override owns the
  skeleton. Starting a gesture underneath one leaves it primed to pop back in
  for the tail of its fade-out when the override releases.
- Every runtime takes an injected `now()`. Do not mix it with `Date.now()`:
  envelopes started against one clock and expired against another release early.
- The animator's default clock is its OWN accumulated `dt`, not
  `performance.now()`: gestures, face clips and blink stop when the engine is
  paused, slow down with `timeScale`, and replay identically under a fixed `dt`.
  Pass `clock: defaultClock` only for an animator driven outside the engine
  loop. A sub-runtime constructed on its own (`createBlinkRuntime()` and
  friends) still defaults to `performance.now()`.
- `MoveCompletedEvent` is pooled per movement component. Read it inside the
  sink; copy anything you need to keep.
- Locomotion clips are CC0 and retargeted offline. Mixamo content is excluded
  for licensing; `assets/mixamo_to_mh.json` is named for the naming convention,
  not for the asset source.
- `spine_02`, `spine_04` and `neck_02` have no source in a three-joint spine and
  stay at their rest rotation after a retarget. That is deliberate.
