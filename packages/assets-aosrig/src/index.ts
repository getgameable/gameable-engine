/**
 * `gameable/aosrig` — the sample character the templates draw.
 *
 * `assets/aosrig_v0.glb` is one 114-joint linear-blend-skinned body (a Meta MHR
 * LOD1 body joined to a Google GNM head) with four embedded glTF animations:
 * `idle`, `walk`, `run` and `wave`. It is Apache-2.0, not CC0 — see `assets/NOTICE.md`
 * — which is why it has its own package rather than living in
 * `gameable/placeholder` (`AGENTS.md` rule 14).
 *
 * The exports below are resolvers and a joint namespace. The engine still
 * addresses the rig by string id through `gameable/assets`: put
 * {@link aosrigManifestEntry} in your manifest and name the id in a prefab's
 * `character` field.
 *
 * @example
 * ```ts
 * import { parseManifest } from 'gameable/assets';
 * import { aosrigManifestEntry, AOSRIG_ASSETS_BASE } from 'gameable/aosrig';
 *
 * const manifest = parseManifest(
 *   { version: 1, assets: [aosrigManifestEntry('char.hero')] },
 *   { baseUrl: AOSRIG_ASSETS_BASE },
 * );
 * console.log(manifest.assets[0].rig?.backend); // 'skinned'
 * ```
 */

import { joinUrl } from '@gameable/assets';
import type { AssetEntry } from '@gameable/assets';

/**
 * Absolute URL of the directory holding the packaged assets, with a trailing
 * slash.
 *
 * Use it as a manifest `baseUrl`. It resolves against this module, so it is
 * correct from `src/` under the `gameable-source` condition, from `dist/` in a
 * published install, and from whatever path a bundler emits.
 *
 * @example
 * ```ts
 * import { AOSRIG_ASSETS_BASE } from 'gameable/aosrig';
 *
 * console.log(AOSRIG_ASSETS_BASE.endsWith('/assets/')); // true
 * ```
 */
export const AOSRIG_ASSETS_BASE: string = new URL('../assets/', import.meta.url).href;

/**
 * File name of the rig inside `assets/`.
 *
 * @example
 * ```ts
 * import { AOSRIG_GLB_FILE } from 'gameable/aosrig';
 *
 * console.log(AOSRIG_GLB_FILE); // 'aosrig_v0.glb'
 * ```
 */
export const AOSRIG_GLB_FILE = 'aosrig_v0.glb' as const;

/**
 * The absolute URL of one packaged file.
 *
 * This is the escape hatch for tooling that wants the bytes directly. Game
 * logic must not call it: assets are addressed by id (`AGENTS.md` rule 3).
 * A bundled app should prefer `import url from
 * 'gameable/assets/aosrig_v0.glb?url'`, which gets the file
 * copied into `dist/` with a hashed name.
 *
 * @param file A file name inside `assets/`, for example `aosrig_v0.glb`.
 * @returns The absolute URL of that file.
 *
 * @example
 * ```ts
 * import { aosrigAssetUrl, AOSRIG_GLB_FILE } from 'gameable/aosrig';
 *
 * const url = aosrigAssetUrl(AOSRIG_GLB_FILE);
 * console.log(url.endsWith('/assets/aosrig_v0.glb')); // true
 * ```
 */
export function aosrigAssetUrl(file: string): string {
  return joinUrl(AOSRIG_ASSETS_BASE, file);
}

/**
 * The hips joint: the one the animator reads root motion from.
 *
 * `body_world` is joint 0 and sits at the origin carrying the vertical bob;
 * `root` is the hips, at 0.924 m in the bind pose. Pass it as
 * `createAnimator({ bones: { root: AOSRIG_ROOT_JOINT } })`, because the
 * animator's own default is Unreal's `pelvis`.
 *
 * @example
 * ```ts
 * import { AOSRIG_ROOT_JOINT } from 'gameable/aosrig';
 *
 * console.log(AOSRIG_ROOT_JOINT); // 'root'
 * ```
 */
export const AOSRIG_ROOT_JOINT = 'root' as const;

/**
 * The head joint, and the leaf of the spine chain.
 *
 * Its presence is what tells the host it is looking at an aosrig skeleton
 * rather than an Unreal one.
 *
 * @example
 * ```ts
 * import { AOSRIG_HEAD_JOINT, AOSRIG_JOINTS } from 'gameable/aosrig';
 *
 * console.log(AOSRIG_JOINTS.includes(AOSRIG_HEAD_JOINT)); // true
 * ```
 */
export const AOSRIG_HEAD_JOINT = 'c_head' as const;

/**
 * How a `look-at` is shared between the neck and the head.
 *
 * The rig has one neck joint rather than Unreal's two, so the default
 * `neck_01 / neck_02 / head` split does not apply: 40 % on `c_neck` and 60 % on
 * `c_head` gives the same overall turn without the neck kinking. Feed it to
 * `createAnimator({ headAim: { joints: AOSRIG_HEAD_AIM_JOINTS } })`.
 *
 * @example
 * ```ts
 * import { AOSRIG_HEAD_AIM_JOINTS } from 'gameable/aosrig';
 *
 * const total = AOSRIG_HEAD_AIM_JOINTS.reduce((sum, [, share]) => sum + share, 0);
 * console.log(total); // 1
 * ```
 */
export const AOSRIG_HEAD_AIM_JOINTS: readonly (readonly [string, number])[] = Object.freeze([
  Object.freeze(['c_neck', 0.4]),
  Object.freeze(['c_head', 0.6]),
]) as readonly (readonly [string, number])[];

/**
 * Standing height of the rig in its bind pose, in metres.
 *
 * Feet are at `y = 0`, so this is also the top of the head. Use it to place a
 * camera or size a physics capsule against the character you are actually
 * going to draw.
 *
 * @example
 * ```ts
 * import { AOSRIG_HEIGHT } from 'gameable/aosrig';
 *
 * const eyeHeight = AOSRIG_HEIGHT * 0.94;
 * console.log(eyeHeight > 1.6); // true
 * ```
 */
export const AOSRIG_HEIGHT = 1.73;

/**
 * Every joint of the rig, in the order the GLB's skin declares them.
 *
 * This is the canonical body skeleton: splat characters are trained against
 * these names, so a clip authored for one aosrig character plays on any other.
 * The order matters — it is the `JOINTS_0` index space — and `src/pack.test.ts`
 * asserts the committed GLB still agrees with this list joint for joint.
 *
 * Index 0 is `body_world` (the skin's skeleton root, at the origin), index 1 is
 * `root` (the hips) and index 113 is `c_head`. The 34 `*_proc` entries are
 * procedural twist joints driven by MHR's forward kinematics; nothing should
 * pose them by hand.
 *
 * @example
 * ```ts
 * import { AOSRIG_JOINTS } from 'gameable/aosrig';
 *
 * console.log(AOSRIG_JOINTS.length); // 114
 * console.log(AOSRIG_JOINTS[0], AOSRIG_JOINTS[1]); // 'body_world' 'root'
 * ```
 */
export const AOSRIG_JOINTS: readonly string[] = Object.freeze([
  'body_world',
  'root',
  'l_upleg',
  'l_lowleg',
  'l_foot',
  'l_talocrural',
  'l_subtalar',
  'l_transversetarsal',
  'l_ball',
  'l_lowleg_twist1_proc',
  'l_lowleg_twist2_proc',
  'l_lowleg_twist3_proc',
  'l_lowleg_twist4_proc',
  'l_upleg_twist0_proc',
  'l_upleg_twist1_proc',
  'l_upleg_twist2_proc',
  'l_upleg_twist3_proc',
  'l_upleg_twist4_proc',
  'r_upleg',
  'r_lowleg',
  'r_foot',
  'r_talocrural',
  'r_subtalar',
  'r_transversetarsal',
  'r_ball',
  'r_lowleg_twist1_proc',
  'r_lowleg_twist2_proc',
  'r_lowleg_twist3_proc',
  'r_lowleg_twist4_proc',
  'r_upleg_twist0_proc',
  'r_upleg_twist1_proc',
  'r_upleg_twist2_proc',
  'r_upleg_twist3_proc',
  'r_upleg_twist4_proc',
  'c_spine0',
  'c_spine1',
  'c_spine2',
  'c_spine3',
  'r_clavicle',
  'r_uparm',
  'r_lowarm',
  'r_wrist_twist',
  'r_wrist',
  'r_pinky0',
  'r_pinky1',
  'r_pinky2',
  'r_pinky3',
  'r_pinky_null',
  'r_ring1',
  'r_ring2',
  'r_ring3',
  'r_ring_null',
  'r_middle1',
  'r_middle2',
  'r_middle3',
  'r_middle_null',
  'r_index1',
  'r_index2',
  'r_index3',
  'r_index_null',
  'r_thumb0',
  'r_thumb1',
  'r_thumb2',
  'r_thumb3',
  'r_thumb_null',
  'r_lowarm_twist1_proc',
  'r_lowarm_twist2_proc',
  'r_lowarm_twist3_proc',
  'r_lowarm_twist4_proc',
  'r_uparm_twist0_proc',
  'r_uparm_twist1_proc',
  'r_uparm_twist2_proc',
  'r_uparm_twist3_proc',
  'r_uparm_twist4_proc',
  'l_clavicle',
  'l_uparm',
  'l_lowarm',
  'l_wrist_twist',
  'l_wrist',
  'l_pinky0',
  'l_pinky1',
  'l_pinky2',
  'l_pinky3',
  'l_pinky_null',
  'l_ring1',
  'l_ring2',
  'l_ring3',
  'l_ring_null',
  'l_middle1',
  'l_middle2',
  'l_middle3',
  'l_middle_null',
  'l_index1',
  'l_index2',
  'l_index3',
  'l_index_null',
  'l_thumb0',
  'l_thumb1',
  'l_thumb2',
  'l_thumb3',
  'l_thumb_null',
  'l_lowarm_twist1_proc',
  'l_lowarm_twist2_proc',
  'l_lowarm_twist3_proc',
  'l_lowarm_twist4_proc',
  'l_uparm_twist0_proc',
  'l_uparm_twist1_proc',
  'l_uparm_twist2_proc',
  'l_uparm_twist3_proc',
  'l_uparm_twist4_proc',
  'c_neck',
  'c_neck_twist1_proc',
  'c_neck_twist0_proc',
  'c_head',
]);

/**
 * The clip names embedded in the GLB, in the order it declares them.
 *
 * `idle`, `walk` and `run` carry `extras.aos.locomotion = true`, so the host
 * builds its locomotion blend from them and picks between them by speed;
 * `wave` does not, so it only plays when a guest asks for it by name with
 * `character.setClipWeights`.
 *
 * @example
 * ```ts
 * import { AOSRIG_CLIPS } from 'gameable/aosrig';
 *
 * console.log(AOSRIG_CLIPS); // ['idle', 'walk', 'run', 'wave']
 * ```
 */
export const AOSRIG_CLIPS: readonly string[] = Object.freeze(['idle', 'walk', 'run', 'wave']);

/**
 * Ground speed each locomotion clip was baked at, in metres per second.
 *
 * The host reads the same numbers out of the GLB's `extras.aos.speed`; they are
 * repeated here so a game can tune its own walk and run speeds against the
 * clips without parsing the file. Match them and the feet do not skate.
 *
 * @example
 * ```ts
 * import { AOSRIG_CLIP_SPEEDS } from 'gameable/aosrig';
 *
 * console.log(AOSRIG_CLIP_SPEEDS.walk, AOSRIG_CLIP_SPEEDS.run); // 1.4 3.6
 * ```
 */
export const AOSRIG_CLIP_SPEEDS: Readonly<Record<string, number>> = Object.freeze({
  idle: 0,
  walk: 1.4,
  run: 3.6,
});

/**
 * A manifest entry for the rig: `gameable/assets`'s own {@link AssetEntry},
 * under a name that says where it came from.
 *
 * It is deliberately not a second declaration of the same shape. The entry goes
 * straight into `parseManifest`, so a local copy could only ever drift from the
 * type that is actually validated.
 *
 * @example
 * ```ts
 * import type { AosrigManifestEntry } from 'gameable/aosrig';
 * import { aosrigManifestEntry } from 'gameable/aosrig';
 *
 * const entry: AosrigManifestEntry = aosrigManifestEntry('char.hero');
 * console.log(entry.type); // 'character'
 * ```
 */
export type AosrigManifestEntry = AssetEntry;

/**
 * Build the manifest entry for the rig under an id of your choosing.
 *
 * The `skinned` backend takes no `pack`: everything the host needs — the mesh,
 * the 114-joint skin and the four clips — is inside the one GLB.
 *
 * @param id The string id game logic will name, for example `char.hero`.
 * @param src Where the GLB is, relative to the manifest's `baseUrl`. Defaults
 *   to {@link AOSRIG_GLB_FILE}.
 * @returns The entry, ready to drop into a manifest's `assets` array.
 *
 * @example
 * ```ts
 * import { parseManifest } from 'gameable/assets';
 * import { aosrigManifestEntry, AOSRIG_ASSETS_BASE } from 'gameable/aosrig';
 *
 * const manifest = parseManifest(
 *   { version: 1, assets: [aosrigManifestEntry('char.hero'), aosrigManifestEntry('char.guide')] },
 *   { baseUrl: AOSRIG_ASSETS_BASE },
 * );
 * console.log(manifest.assets.map((a) => a.id)); // ['char.hero', 'char.guide']
 * ```
 */
export function aosrigManifestEntry(
  id: string,
  src: string = AOSRIG_GLB_FILE,
): AosrigManifestEntry {
  return { id, type: 'character', src, tags: ['character', 'aosrig'], rig: { backend: 'skinned' } };
}

/**
 * Package identity marker.
 *
 * @example
 * ```ts
 * import { PACKAGE } from 'gameable/aosrig';
 *
 * console.log(PACKAGE); // 'gameable/aosrig'
 * ```
 */
export const PACKAGE = '@gameable/assets-aosrig' as const;
