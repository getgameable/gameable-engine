/**
 * Play Solo for this page: the authority runs here too, as the game's wasm
 * guest on its own headless engine, with the Jolt world and the page's
 * physics options. The arena's collider comes from the manifest, built by the
 * authority before the guest's `init`. Host code only (it reaches the
 * bundler's `?url` files through `src/hostAssets.ts`).
 */
import { startPlaySolo, type InPageAuthority, type WasmGuest } from 'gameable/net/solo';
import type { GameDefinition } from 'gameable';

import { buildManifest, joltWasmUrl } from './hostAssets';
import { PHYSICS_OPTIONS } from './physicsOptions';

/**
 * The game built to wasm, where the plugin serves it (`dist/guest/` after a
 * build; `build/guest/` under `npm run dev`, once `npm run build:guest` ran).
 *
 * @returns The transpiled guest's module URL and its core-module loader.
 */
export function wasmGuest(): WasmGuest {
  const base = new URL(import.meta.env.GAMEABLE_GUEST_URL, location.href);
  return {
    guestModuleUrl: base.href,
    getCoreModule: (path) => WebAssembly.compileStreaming(fetch(new URL(path, base).href)),
  };
}

/**
 * Play Solo, as the page starts it (`startPlaySolo`): under `npm run dev`,
 * first warn when the built guest is stale (the dev server answers), then
 * start the authority. It is wasm even under `npm run dev`, where this page's
 * own client guest is direct: two direct guests in one realm would share the
 * SDK's component arrays, and the SDK refuses that.
 *
 * @param definition The game, read for its seats and send rate.
 * @param seed The run seed.
 * @param warn Shows a warning in the console and on screen.
 * @returns The started authority; `drive` it from the page's engine.
 * @throws {Error} When the guest cannot be loaded or dies on its first step.
 */
export function playSolo(
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
