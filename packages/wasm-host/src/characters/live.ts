/** What the character bridge keeps per character while it lives. */
import type { Animator, CharacterState } from '@gameable/animation';
import { Group, Object3D, Quaternion } from 'three/webgpu';
import type { Bone, Material } from 'three/webgpu';
import type { Entity } from '@gameable/sdk';
import type { AosrigSplatRuntime, JointOverride, RigPreview } from '@gameable/character';
import type { AnimatedSplat, KeyLightEstimate } from '@gameable/splat';
import type { SkeletonProfile } from './profiles.js';
import type { CharacterPath } from './types.js';
import type { BundleCharacter } from './util.js';

/** A {@link JointOverride} whose quaternion this bridge rewrites every frame. */
export interface MutableJointOverride extends JointOverride {
  /** Parent-relative rotation as `(w, x, y, z)` — the rig's order, not three's. */
  rotation: [number, number, number, number];
}

/**
 * One bone head aim drives on a three skeleton, and the bookkeeping to drive it
 * idempotently.
 *
 * The mixer writes `bone.quaternion` from the clips and the bridge then
 * pre-multiplies the aim onto it. When every action is stopped — a guest that
 * drives clips explicitly and sets them all to zero — the mixer writes nothing
 * and the bone still holds LAST frame's already-aimed value, so a naive
 * pre-multiply would compound the turn until the head spun. Remembering both
 * quaternions makes the difference detectable: if the bone is still exactly
 * what was written, the mixer did not run, and the animated value is restored
 * before the new aim goes on.
 */
export interface AimBone {
  /** The bone name, as the animator's override map keys it. */
  readonly joint: string;
  /** The live bone. */
  readonly bone: Bone;
  /** The mixer's output for this bone last frame, before the aim. */
  readonly base: Quaternion;
  /** What the bridge wrote onto the bone last frame, after the aim. */
  readonly applied: Quaternion;
}

/** {@link CharacterState} with the fields this bridge mutates spelled mutable. */
export interface MutableCharacterState extends CharacterState {
  /** Clip requests from `set-clip-weights`. */
  clips: { name: string; weight: number }[];
  /** The expression vector, or undefined before the first `set-expression`. */
  expression?: Float32Array;
  /** The look target, or null. */
  lookAt: [number, number, number] | null;
  /** World-space velocity. */
  velocity: [number, number, number];
  /** Whether the controller is grounded. */
  grounded: boolean;
}

/** Everything the bridge keeps per character. */
export interface LiveCharacter {
  /** The entity. */
  readonly entity: Entity;
  /** Manifest id of the bundle. */
  readonly bundleId: string;
  /** Which path this character took. */
  kind: CharacterPath;
  /** The guest's own state name, from the last `set-character-state`. */
  stateName: string;
  /** Where the head hangs, under the entity's own object. */
  readonly holder: Group;
  /**
   * The holder's local position before any path-specific offset, in metres.
   *
   * `spawn` adds the head offset to the holder because that is right for every
   * head-only path; a skinned body wants the ground offset instead, and gets
   * there by rewriting the holder from this rather than by unpicking the sum.
   */
  readonly local: readonly [number, number, number];
  /** Metres from the entity's origin down to the floor; see the spawn request. */
  readonly groundOffset: number;
  /** The animator's root: a neck chain, positioned so head aim is world-correct. */
  readonly root: Object3D;
  /** The entity's own object, whose world yaw is the character's facing. */
  readonly parent: Object3D;
  /** The state handed to the animator; mutated in place, never reallocated. */
  readonly state: MutableCharacterState;
  /**
   * Pooled clip requests behind `state.clips`.
   *
   * `set-clip-weights` arrives every step from a game that drives its own
   * blend, so the `{ name, weight }` pairs are rewritten rather than rebuilt.
   * `state.clips` is emptied and refilled from this, which keeps its own
   * backing capacity too.
   */
  readonly clipPool: { name: string; weight: number }[];
  /**
   * Pooled look target behind `state.lookAt`.
   *
   * `look-at` is per-frame on any character that tracks the player, and the
   * animator reads the tuple synchronously, so one array serves every frame.
   */
  readonly lookScratch: [number, number, number];
  /** The animator, once the bundle's expression space is known. */
  animator: Animator | null;
  /** The rig preview, on the GNM path. */
  preview: RigPreview | null;
  boundSplats?: AosrigSplatRuntime;
  /** The full character, on the decoder path. */
  character: BundleCharacter | null;
  /** The gaussian sink, once it exists. */
  sink: AnimatedSplat | null;
  /** The teeth's own points, when the exported package carries them and the renderer can mask them. */
  teethSink?: AnimatedSplat | null;
  /** Control vector handed to the backend each frame, on the GNM path. */
  controls: Float32Array | null;
  /** Index of the first gaze channel in `controls`, or -1 when there is none. */
  gazeOffset: number;
  /**
   * Reused joint-override records handed to the rig each frame, one per joint
   * the animator's head aim drives. Built once; `rotation` is mutated in place.
   */
  joints: MutableJointOverride[] | null;
  /**
   * The rotations last PUSHED to the rig, four floats per entry of `joints`.
   *
   * Head aim converges and then resends the same quaternions every frame. Pushing
   * them re-ran the GNM backend's whole joint walk — a Map rebuild, two `J*16`
   * allocations and a skin-matrix pass — for a head that was not moving.
   */
  jointsPushed: Float32Array | null;
  /**
   * The control vector last pushed to the rig preview, or null before the first push.
   *
   * The FIRST push is unconditional even when the vector is all zeros: an all-zero
   * neutral is a real expression and "never pushed" is not the same as "pushed
   * zeros". After that an identical vector is dropped.
   */
  controlsPushed: Float32Array | null;
  /** The cloned skinned rig, on the skinned path. */
  rig: Object3D | null;
  ownsRig?: boolean;
  /** The skeleton's bone names for the animator, the head aim and the shadows (skinned path). */
  profile?: SkeletonProfile;
  /** The head and skeleton files kept for an upgrade, by SHA-256 (`extras.keepSharedFiles`). */
  sharedFiles?: Map<string, Uint8Array>;
  /**
   * While an upgrade dissolves in: the old points (still posed each frame, underneath) and the
   * new points' opacity. Absent otherwise.
   */
  fading?: {
    runtime: AosrigSplatRuntime;
    sink: AnimatedSplat;
    teethSink: AnimatedSplat | null;
    alpha: { value: number };
    start: number;
    ms: number;
    done: () => void;
  };
  /**
   * The live bones head aim drives, on the skinned path.
   *
   * The animator folds its overrides into `bodyPose` and into its own map, but
   * never onto three's bones — a rig backend that takes them separately must
   * not have them applied twice. A three skeleton IS the renderer, so on this
   * path the bridge applies them itself, every frame, after `animator.update`.
   */
  aimBones: AimBone[] | null;
  /** Clip names registered on the animator, in file order. */
  clips: string[];
  /** Materials cloned for this entity by `set-material-param`, to be disposed. */
  ownMaterials: Material[] | null;
  /** ARKit-52 scratch the guest writes into. */
  readonly arkit: Float32Array;
  /** Bundle-space scratch, allocated once the dimension is known. */
  native: Float32Array | null;
  /** True once the rig draws and the placeholder can go. */
  ready: boolean;
  /** The light its colours were captured under (its own space), read at load for the shadows. */
  capturedLight?: KeyLightEstimate | null;
  /** True after `despawn`, so an in-flight load throws its work away. */
  dead: boolean;
  /** Called once the head is on screen. */
  readonly onAttached?: () => void;
}
