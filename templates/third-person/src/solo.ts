/**
 * Play Solo for a multiplayer game: the authority runs in this page too, as
 * the game's wasm guest on its own headless engine, with the Jolt world and
 * the physics options from `src/physicsOptions.ts`. The arena's collider is in
 * the manifest (`env.arena`'s `collider`), and the authority builds it before
 * the guest's `init`, as a room server does.
 *
 * The authority runs the BUILT guest, even under `npm run dev`: run
 * `npm run build:guest` after each change to the game's rules. Under
 * `npm run dev` the page warns when `build/guest/` is older than `src/`.
 *
 * Loaded only by a multiplayer page with no `?room=` (`src/online.ts`), so a
 * room page never downloads it.
 */
import { startPlaySolo, type InPageAuthority } from 'gameable/net/solo';
import type { GameDefinition } from 'gameable';

import { buildManifest, joltWasmUrl } from './hostAssets';
import { PHYSICS_OPTIONS } from './physicsOptions';
import { wasmGuest } from './sandbox';

/**
 * Start the authority. It is wasm even under `npm run dev`, where this page's
 * own client guest is direct: two direct guests in one realm would share the
 * SDK's component arrays, and the SDK refuses that.
 *
 * @param definition The game, read for its seats and send rate.
 * @param seed The run seed.
 * @param warn Shows a warning (a stale guest under `npm run dev`).
 * @returns The started authority; `drive` it from the page's engine.
 * @throws {Error} When the guest cannot be loaded or dies on its first step.
 */
export function startSolo(
  definition: GameDefinition,
  seed: number,
  warn: (message: string) => void,
): Promise<InPageAuthority> {
  return startPlaySolo({
    guest: wasmGuest(),
    definition,
    manifest: buildManifest(),
    physicsOptions: { ...PHYSICS_OPTIONS, wasmUrl: joltWasmUrl },
    seed,
    dev: import.meta.env.DEV,
    warn,
  });
}
