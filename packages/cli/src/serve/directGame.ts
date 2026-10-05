/**
 * `serve --direct`: the game's `src/game.ts`, loaded through the game's own
 * Vite, runs in this process as one room. The room server itself is loaded
 * through the same Vite, so the game and the engine share one copy of the
 * SDK (its component stores are module state).
 */
import type { PlayerStore } from '@gameable/net/server';

import { gameNameOf } from './gameName.js';
import { openGameVite, readGameModule } from './gameModule.js';
import { directManifest, readFileAsset } from './manifestFiles.js';
import { roomSeeds, type ServeOptions } from './options.js';
import type { GameSet, RoomsApi } from './startServe.js';

/** Jolt's options as `engineGame` takes them. */
type EnginePhysics = Parameters<RoomsApi['engineGame']>[0]['physicsOptions'];

/**
 * @param options The resolved options (`mode: 'direct'`).
 * @param joltWasm Jolt's wasm file.
 * @param store The player store, or none.
 * @returns The one game, and a `close` that stops its Vite.
 * @throws {Error} When the game or the room server cannot be loaded.
 */
export async function openDirectGame(
  options: ServeOptions,
  joltWasm: string,
  store?: PlayerStore,
): Promise<GameSet> {
  const { gameDir } = options;
  const name = gameNameOf(gameDir);
  const vite = await openGameVite(gameDir);
  try {
    const module = await readGameModule(vite, gameDir);
    const rooms = (await vite.ssrLoadModule('gameable/rooms/server')) as unknown as RoomsApi;
    const physicsOptions = { ...module.physics, wasmUrl: joltWasm } as EnginePhysics;
    const game = rooms.engineGame({
      definition: module.definition,
      manifest: directManifest(gameDir),
      readAsset: readFileAsset,
      physicsOptions,
      seed: roomSeeds(options.seed),
      ...(store === undefined ? {} : { data: { store, game: name } }),
    });
    const about = `${name}: src/game.ts in this process (direct), physics from ${module.physicsFrom}`;
    return { rooms, games: [{ name, game, about }], close: () => vite.close() };
  } catch (error) {
    await vite.close();
    throw error;
  }
}
