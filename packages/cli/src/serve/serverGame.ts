/**
 * `dist/server/game.json`: what a room server needs to host a built game
 * without its TypeScript. The wasm guest beside it (`dist/guest/`) is the
 * game; this file is what the guest cannot say across the WIT boundary.
 *
 * ```text
 * dist/
 *   guest/game.js, *.wasm      the game, built to wasm
 *   server/game.json           this file
 *   server/assets.json         the manifest, collider sources rewritten:
 *   server/colliders/<id>.bin  the level's collision meshes
 * ```
 */
import type { FeatureSpec, WorldSpec } from '@gameable/sdk';

import type { PhysicsData } from './gameModule.js';

/** The `game.json` format. */
export interface ServerGameJson {
  /** The catalog name: the package name without its scope. */
  readonly name: string;
  /** The definition's `features`, as declared. */
  readonly features: FeatureSpec;
  /** The definition's `world`. */
  readonly world: WorldSpec;
  /** Jolt's options, from `src/physicsOptions.ts` (the page's own), without `wasmUrl`. */
  readonly physics: PhysicsData;
  /** `roomSeats(definition)`: seats per room. */
  readonly maxPlayers: number;
  /** `roomSendHz(definition)`: rows per second to each player. */
  readonly sendHz: number;
}

/** Where the bundle lives inside a game's `dist/`. */
export const SERVER_DIR = 'server';
/** The bundle's description of the game. */
export const GAME_JSON = 'game.json';
/** The manifest the server reads. */
export const SERVER_MANIFEST = 'assets.json';
/** The level's collision meshes, one per entry. */
export const COLLIDERS_DIR = 'colliders';

/**
 * @param id A manifest entry id.
 * @returns The file name its collider is copied to (anything outside `[\w.-]` becomes `_`).
 */
export function colliderFileOf(id: string): string {
  return `${id.replace(/[^\w.-]/g, '_')}.bin`;
}

/**
 * @param id A manifest entry id.
 * @param used The file names taken so far; this one is added.
 * @returns Its collider's file name.
 * @throws {Error} When an earlier id already took the same name (`env/arena` and `env_arena`).
 */
export function uniqueColliderFile(id: string, used: Set<string>): string {
  const file = colliderFileOf(id);
  if (used.has(file)) throw new Error(`"${id}" and an earlier entry both copy their collider to ${file}: rename one`);
  used.add(file);
  return file;
}
