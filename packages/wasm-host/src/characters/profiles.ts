/**
 * The skeletons the character bridge recognises, and what a glTF clip says about itself
 * (`extras.aos`): the part of the bridge with no state.
 */
import { HEAD_AIM_DEFAULTS, type LocomotionIndex } from '@gameable/animation';
import type { AnimationClip, Object3D } from 'three/webgpu';

/**
 * What a rig calls the bones the animator addresses, and how it shares the aim.
 *
 * Deliberately duplicated from `gameable/aosrig`: this package must
 * not depend on an asset package — a game that ships its own body should not
 * pull `aosrig_v0.glb`'s metadata in to use it — so the two are tested against
 * each other rather than shared.
 */
export interface SkeletonProfile {
  /** Bone the animator reads `bodyPose.rootPos` from. */
  readonly root: string;
  /** Bone head aim measures the look direction from. */
  readonly head: string;
  /** Bones that share the aim, and the fraction each takes. */
  readonly headAim: readonly (readonly [string, number])[];
  /** The foot joints the contact shadow stands on, when the shadows' defaults do not name them. */
  readonly feet?: readonly string[];
}

/** `aosrig_v0`: MHR body joined to a GNM head, 114 joints, `c_`-prefixed. */
export const AOSRIG_PROFILE: SkeletonProfile = {
  root: 'root',
  head: 'c_head',
  // Two joints, not three: aosrig has one neck. The head takes the larger share
  // so the chin leads the turn, which is what reads as "looking", not "leaning".
  headAim: [
    ['c_neck', 0.4],
    ['c_head', 0.6],
  ],
};

/**
 * `aosrig-v2`: SOMA's skeleton, 110 joints (the package format's version 2). Two neck
 * joints and the head share the aim as the studio's package says.
 */
export const SOMA_PROFILE: SkeletonProfile = {
  root: 'Hips',
  head: 'Head',
  headAim: [
    ['Neck1', 0.2],
    ['Neck2', 0.3],
    ['Head', 0.5],
  ],
  feet: ['LeftFoot', 'RightFoot'],
};

/** The UE-style names every GNM pack and most retargeted bodies use. */
export const UE_PROFILE: SkeletonProfile = {
  root: 'pelvis',
  head: 'head',
  headAim: HEAD_AIM_DEFAULTS.joints,
};

/**
 * Which skeleton a loaded rig has, probed rather than declared.
 *
 * The manifest says `backend: 'skinned'` and nothing else; making the game
 * author also name their bone convention would be a second thing to get wrong,
 * and the rig itself already knows. `c_head` is the tell: no UE skeleton has a
 * bone by that name and every aosrig does.
 *
 * @param root The cloned rig root.
 *
 * @returns The profile to configure the animator with.
 */
export function profileFor(root: Object3D): SkeletonProfile {
  return root.getObjectByName(AOSRIG_PROFILE.head) === undefined ? UE_PROFILE : AOSRIG_PROFILE;
}

/** `extras.aos` on a glTF animation, as the exporter writes it. */
export interface AosClipMeta {
  /** Authored ground speed in metres per second; 0 for idle. */
  readonly speed: number;
  /** Whether the clip loops. */
  readonly loop: boolean;
  /** Whether the clip belongs in the speed-matched locomotion blend. */
  readonly locomotion: boolean;
}

/**
 * Read `clip.userData.aos`, filling in what the exporter left out.
 *
 * `GLTFLoader` copies an animation's glTF `extras` straight into `userData`, so
 * everything in here came from a file and none of it is trustworthy: a string
 * `"1.4"` where a number belongs must not become a NaN blend weight ten layers
 * down.
 *
 * @param clip The clip.
 *
 * @returns The metadata, with `speed: 0`, `loop: true`, `locomotion: false` as
 *   the defaults for anything missing or of the wrong type.
 */
export function aosMetaOf(clip: AnimationClip): AosClipMeta {
  const raw = (clip.userData as { aos?: unknown } | undefined)?.aos;
  const aos = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  const speed = aos.speed;
  const loop = aos.loop;
  const locomotion = aos.locomotion;
  return {
    speed: typeof speed === 'number' && Number.isFinite(speed) && speed >= 0 ? speed : 0,
    loop: typeof loop === 'boolean' ? loop : true,
    locomotion: locomotion === true,
  };
}

/**
 * The locomotion blend space a GLB's own animations describe.
 *
 * @param clips Every animation in the file.
 * @param url The file, which is what `LocomotionClipMeta.file` records.
 *
 * @returns The index, or null when no clip claims to be locomotion.
 *
 * @example
 * ```ts
 * import { locomotionIndexOf } from 'gameable/host/characters';
 *
 * const index = locomotionIndexOf(gltf.animations, '/aosrig_v0.glb');
 * console.log(index?.clips.map((c) => c.name)); // ['idle', 'walk', 'run']
 * ```
 */
export function locomotionIndexOf(
  clips: readonly AnimationClip[],
  url: string,
): LocomotionIndex | null {
  const out = [];
  for (const clip of clips) {
    const meta = aosMetaOf(clip);
    if (!meta.locomotion) continue;
    out.push({ name: clip.name, file: url, loop: meta.loop, speed: meta.speed });
  }
  return out.length === 0 ? null : { clips: out };
}
