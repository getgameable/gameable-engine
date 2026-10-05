# Animation

A character is animated by one object. `createAnimator({ root, expressionSpace })`
binds a skinned rig root to four layers, and `update(dt)` evaluates all four and
refreshes four output buffers in place. Nothing in the per-frame path allocates.

```ts
import { createAnimator, validateCharacterState } from 'gameable/animation';

const animator = createAnimator({
  root: rigRoot,
  expressionSpace: { kind: 'arkit52', dim: 52 },
  locomotion: locomotionIndex,
});

animator.addClip('idle', idleClip);
animator.addClip('walk', walkClip);

animator.setState(validateCharacterState(frame.character));
animator.update(dt, { camera });
```

## The four layers

**Body base.** An `AnimationMixer`. Its weights come from one of three sources,
checked in this order:

1. a blueprint graph, if `setGraph` was called — `playClip`, `blend`, `select`
   and a rule-guarded state machine, evaluated into clip weights;
2. `state.clips`, when the guest drives clips explicitly by name and weight;
3. otherwise the locomotion blend, from `state.velocity`.

**Additive / gesture.** One slot. A gesture is a clip registered with
`{ additive: true }` and played through `animator.gesture.play(name, { durationMs })`,
which runs a fade-in, hold, fade-out envelope over it. It is applied after the
base layer's weight pass and before the mixer advances, so the base layer cannot
overwrite the envelope.

**Face.** Face clips are per-frame ARKit-52 blendshape weights, blended by drive
weight and interpolated across the loop boundary. The result is mapped into the
bundle's expression space and published as `animator.expression`. A guest that
computes its own expression vector can supply one on `state.expression` instead.

**Procedural.** Blink overlays the ARKit blink channels. Head aim turns the neck
and head toward `state.lookAt` — or the camera — and publishes the rotations as
`animator.jointOverrides`. Whatever the neck could not reach is handed to the
eyes as `animator.gaze`, `[pitchL, yawL, pitchR, yawR]` in radians.

## The locomotion blend

Locomotion clips are tagged with the ground speed they were authored at. The
sample character's clips travel inside its GLB, each glTF animation carrying
`extras.aos = { speed, loop, locomotion }`, which `GLTFLoader` copies into
`clip.userData`; the character bridge builds the `LocomotionIndex` from the
clips tagged `locomotion` and registers every clip by name. Clips retargeted by
`packages/animation/tools/retarget_locomotion.mjs` arrive as one GLB each plus a
`locomotion.json` with the same fields, and `createAnimator` takes that index
directly.

At runtime the character's PLANAR speed — Y is excluded, because a falling
character is not sprinting — picks the two clips bracketing it and crossfades
them. Outside the bracketed range the blend clamps to the nearest clip and
scales its playback instead: a 4 m/s run clip played at 6 m/s runs at 1.5x, so
the stride keeps up with the ground and the feet do not skate.

A character the Gameable studio exports (version 2) brings its clips in
`clips.json`, on its own skeleton; `somaAnimationClip` turns each into an
`AnimationClip`. A looping clip gets a closing key equal to its first frame at
`frames / fps`, so its wrap skips no frame; one whose root travels (more than
5 cm) keeps moving at its last velocity instead. Its face `map` is the package's
fitted ARKit table (`createFittedArkitMap`) when it has one. A version 1 package's
clips (in `rig.glb`) have no closing key: their loops still skip a frame.

## Expression spaces

Face clips are always ARKit-52. A bundle whose head is a GNM model wants 383
coefficients, or the reduced 68. That mapping belongs to the bundle, not to the
engine — two characters in one scene can be in different spaces — so
`expressionSpace` carries it:

```ts
{ kind: 'gnm', dim: 383, map: (arkit, out) => { /* bundle-supplied */ } }
```

`createAnimator` throws if a non-ARKit space arrives without a `map`. The
procedural blink composes in ARKit space, before the map runs.

## Head aim clamps against the body

The head look-at clamps yaw relative to the body's current forward, not to world
+Z. With a world-anchored clamp, locomotion — which yaws the whole character to
face the walk direction — lets the head reach body-yaw plus the neck limit,
which is a neck that rotates a great deal further than a neck can. Clamping
relative to the torso keeps the head within its limit whichever way the body
faces.

The body's forward is `root.rotation.y` unless the update context passes
`bodyYaw`, which a rig parented under an entity group must do: the group carries
the facing and the rig root draws, so rotating it again would double-rotate.
The aim is split across `neck_01`, `neck_02` and `head` by default, or across
whatever `headAim.joints` names — `c_neck` and `c_head` for the aosrig_v0
skeleton, whose root bone is `root` rather than `pelvis` (`bones: { root, head }`).
Each override is a parent-local delta that pre-multiplies the bone's animated
rotation.
`animator.bodyPose` already has them folded in; `animator.jointOverrides` is for
rig backends that take joint overrides as their own input. Use one or the other.

## Additive clips are baked, not layered at runtime

Unreal computes an additive delta when the animation asset is built, not at the
ApplyAdditive graph node. `bakeAdditive` reproduces that: it takes the additive
type, base pose type and reference frame index that the FBX to glTF conversion
strips, and rewrites the clip's keyframes once at load time. Nothing about
additive layering runs per frame.

## See also

- [Characters](./characters.md)
- [Play an animation](../recipes/play-an-animation.md)
- `packages/animation/README.md` — gameable/animation
