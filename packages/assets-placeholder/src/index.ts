/**
 * `gameable/placeholder` — the arena, the sound effects and the face
 * clip that let a scaffold render something before real content exists.
 *
 * Every byte in `assets/` is produced by `scripts/gen-*.mjs` from seeded maths,
 * so the pack is CC0 with nothing to attribute (see `assets/CREDITS.md`). The
 * exports below are only resolvers and typed copies of the JSON: the engine
 * still addresses everything by string id through `gameable/assets`.
 *
 * @example
 * ```ts
 * import { placeholderManifest, PLACEHOLDER_ASSETS_BASE } from 'gameable/placeholder';
 * import { createEngine } from 'gameable/core';
 *
 * const engine = await createEngine({
 *   manifest: { ...placeholderManifest, baseUrl: PLACEHOLDER_ASSETS_BASE },
 * });
 * ```
 */

import { joinUrl } from '@gameable/assets';
import type { AssetCollider, AssetEntry } from '@gameable/assets';

export { ColliderFormatError, encodeCollider, parseCollider } from './collider.js';
export type { ColliderMesh, ParseColliderOptions } from './collider.js';

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
 * import { PLACEHOLDER_ASSETS_BASE } from 'gameable/placeholder';
 *
 * console.log(PLACEHOLDER_ASSETS_BASE.endsWith('/assets/')); // true
 * ```
 */
export const PLACEHOLDER_ASSETS_BASE: string = new URL('../assets/', import.meta.url).href;

/**
 * The absolute URL of one packaged file.
 *
 * This is the escape hatch for the two files that cannot live in the manifest —
 * `arena.spawns.json` and `face_idle.arkit.json` — and for tooling that wants
 * the bytes directly. Game logic must not call it: assets are addressed by id
 * (`AGENTS.md` rule 3), and the ids are in {@link placeholderManifest}.
 *
 * @param file A file name inside `assets/`, for example `arena.spz`.
 * @returns The absolute URL of that file.
 *
 * @example
 * ```ts
 * import { placeholderAssetUrl } from 'gameable/placeholder';
 *
 * const url = placeholderAssetUrl('face_idle.arkit.json');
 * console.log(url.endsWith('/assets/face_idle.arkit.json')); // true
 * ```
 */
export function placeholderAssetUrl(file: string): string {
  return joinUrl(PLACEHOLDER_ASSETS_BASE, file);
}

/**
 * A static collision proxy, as the manifest declares it.
 *
 * This is `gameable/assets`'s own {@link AssetCollider}, not a copy of it:
 * the pack's entries go straight into `parseManifest`, so a second declaration
 * of the same shape could only ever drift from the one that is validated.
 *
 * @example
 * ```ts
 * import type { PlaceholderCollider } from 'gameable/placeholder';
 *
 * const collider: PlaceholderCollider = {
 *   shape: 'mesh',
 *   src: 'arena.collider.bin',
 *   layer: 'static',
 * };
 * console.log(collider.src); // 'arena.collider.bin'
 * ```
 */
export type PlaceholderCollider = AssetCollider;

/**
 * One entry of {@link placeholderManifest}: an `gameable/assets`
 * {@link AssetEntry}, under a name that says where it came from.
 *
 * @example
 * ```ts
 * import type { PlaceholderAssetEntry } from 'gameable/placeholder';
 * import { placeholderManifest } from 'gameable/placeholder';
 *
 * const sfx: readonly PlaceholderAssetEntry[] = placeholderManifest.assets.filter(
 *   (a) => a.tags?.includes('sfx') ?? false,
 * );
 * console.log(sfx.length); // 4
 * ```
 */
export type PlaceholderAssetEntry = AssetEntry;

/**
 * The shape of `assets/assets.json`.
 *
 * @example
 * ```ts
 * import type { PlaceholderManifest } from 'gameable/placeholder';
 * import { placeholderManifest } from 'gameable/placeholder';
 *
 * const manifest: PlaceholderManifest = placeholderManifest;
 * console.log(manifest.version); // 1
 * ```
 */
export interface PlaceholderManifest {
  /** Manifest schema version. */
  readonly version: 1;
  /** Every placeholder asset, in load order. */
  readonly assets: readonly AssetEntry[];
}

/**
 * A typed, ready-to-parse copy of `assets/assets.json`.
 *
 * It has no `baseUrl`, so merge {@link PLACEHOLDER_ASSETS_BASE} in when you feed
 * it to `parseManifest`, or point `loadManifest` at the JSON file itself and let
 * it default the base to the file's own directory. A unit test asserts this
 * object and the JSON never drift apart.
 *
 * `face.idle` is deliberately absent: `docs/schemas/assets.schema.json` fixes
 * `type` to `splat | gltf | character | audio`, an ARKit clip is none of those,
 * and extending the schema is out of scope for a placeholder pack. Reach it with
 * `placeholderAssetUrl('face_idle.arkit.json')` instead.
 *
 * @example
 * ```ts
 * import { parseManifest } from 'gameable/assets';
 * import { placeholderManifest, PLACEHOLDER_ASSETS_BASE } from 'gameable/placeholder';
 *
 * const manifest = parseManifest(placeholderManifest, { baseUrl: PLACEHOLDER_ASSETS_BASE });
 * console.log(manifest.assets.map((a) => a.id)); // ['env.arena', 'sfx.shot', ...]
 * ```
 */
export const placeholderManifest: PlaceholderManifest = {
  version: 1,
  assets: [
    {
      id: 'env.arena',
      type: 'splat',
      src: 'arena.spz',
      tags: ['world', 'placeholder'],
      collider: { shape: 'mesh', src: 'arena.collider.bin', layer: 'static' },
    },
    { id: 'sfx.shot', type: 'audio', src: 'shot.wav', tags: ['sfx', 'placeholder'] },
    { id: 'sfx.hit', type: 'audio', src: 'hit.wav', tags: ['sfx', 'placeholder'] },
    { id: 'sfx.pickup', type: 'audio', src: 'pickup.wav', tags: ['sfx', 'placeholder'] },
    { id: 'sfx.step', type: 'audio', src: 'step.wav', tags: ['sfx', 'placeholder'] },
  ],
};

/**
 * A place to put something, with the direction it should face.
 *
 * @example
 * ```ts
 * import type { SpawnPoint } from 'gameable/placeholder';
 * import { arenaSpawns } from 'gameable/placeholder';
 *
 * const spawn: SpawnPoint = arenaSpawns.player;
 * console.log(spawn.position[1]); // 0 — feet on the floor
 * ```
 */
export interface SpawnPoint {
  /** World position `[x, y, z]` in metres, Y-up, origin at the floor centre. */
  readonly position: readonly [number, number, number];
  /** Yaw in radians about `+Y`; `0` looks down `-Z`, like three's `rotation.y`. */
  readonly yaw: number;
}

/**
 * The axis-aligned box the playable arena occupies.
 *
 * @example
 * ```ts
 * import type { ArenaBounds } from 'gameable/placeholder';
 * import { arenaSpawns } from 'gameable/placeholder';
 *
 * const bounds: ArenaBounds = arenaSpawns.bounds;
 * console.log(bounds.max[0] - bounds.min[0]); // 24 — the floor is 24 m across
 * ```
 */
export interface ArenaBounds {
  /** Minimum corner `[x, y, z]` in metres. */
  readonly min: readonly [number, number, number];
  /** Maximum corner `[x, y, z]` in metres. */
  readonly max: readonly [number, number, number];
}

/**
 * The shape of `assets/arena.spawns.json`.
 *
 * @example
 * ```ts
 * import type { ArenaSpawns } from 'gameable/placeholder';
 * import { arenaSpawns } from 'gameable/placeholder';
 *
 * const spawns: ArenaSpawns = arenaSpawns;
 * console.log(spawns.units, spawns.up); // 'metres' '+Y'
 * ```
 */
export interface ArenaSpawns {
  /** Which script produced the file. */
  readonly generatedBy: string;
  /** Length unit every coordinate is in. */
  readonly units: 'metres';
  /** Which axis points up. */
  readonly up: '+Y';
  /** How to read the `yaw` fields. */
  readonly yawConvention: string;
  /** The playable volume: floor, walls and everything between them. */
  readonly bounds: ArenaBounds;
  /** Where the player starts, facing the centre. */
  readonly player: SpawnPoint;
  /** Six enemy spawn points, spread around the perimeter. */
  readonly enemies: readonly SpawnPoint[];
  /** Three pickup positions, floating a metre above the floor. */
  readonly pickups: readonly SpawnPoint[];
}

/**
 * A typed, ready-to-use copy of `assets/arena.spawns.json`.
 *
 * Spawn points are not assets — there is no manifest type for "a list of
 * coordinates" and inventing one would be a schema change — so they ship as a
 * plain export. A unit test asserts this object and the JSON never drift apart,
 * and that every point sits inside {@link ArenaSpawns.bounds}.
 *
 * @example
 * ```ts
 * import { arenaSpawns } from 'gameable/placeholder';
 *
 * const { position, yaw } = arenaSpawns.player;
 * console.log(position, yaw); // [0, 0, 9] 0
 * console.log(arenaSpawns.enemies.length); // 6
 * ```
 */
export const arenaSpawns: ArenaSpawns = {
  generatedBy: 'packages/assets-placeholder/scripts/gen-arena.mjs',
  units: 'metres',
  up: '+Y',
  yawConvention: 'radians about +Y; 0 looks down -Z, matching three.js rotation.y',
  bounds: { min: [-12, 0, -12], max: [12, 3, 12] },
  player: { position: [0, 0, 9], yaw: 0 },
  enemies: [
    { position: [-9.5, 0, -9.5], yaw: -2.3562 },
    { position: [9.5, 0, -9.5], yaw: 2.3562 },
    { position: [-9.5, 0, 9.5], yaw: -0.7854 },
    { position: [9.5, 0, 9.5], yaw: 0.7854 },
    { position: [0, 0, -10.5], yaw: 3.1416 },
    { position: [3, 0, -2], yaw: 2.1588 },
  ],
  pickups: [
    { position: [0, 1, 0], yaw: 0 },
    { position: [-8.5, 1, -8.5], yaw: -2.3562 },
    { position: [8.5, 1, 8.5], yaw: 0.7854 },
  ],
};

/**
 * Package identity marker.
 *
 * @example
 * ```ts
 * import { PACKAGE } from 'gameable/placeholder';
 *
 * console.log(PACKAGE); // 'gameable/placeholder'
 * ```
 */
export const PACKAGE = '@gameable/assets-placeholder' as const;
