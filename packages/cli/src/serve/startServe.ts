/**
 * Start the room server for `gameable serve`: the player store (Postgres
 * from `GAMEABLE_PG_URL`, else memory), the games (one direct, or built ones),
 * `createRoomServer` on them, `listen()`.
 */
import { createRequire } from 'node:module';

import type { CatalogGame, createRoomServer, engineGame } from '@gameable/rooms/server';

import type { ServeOptions } from './options.js';

/** The two functions of `@gameable/rooms/server` that serve uses. */
export interface RoomsApi {
  readonly createRoomServer: typeof createRoomServer;
  readonly engineGame: typeof engineGame;
}

/** A game ready for the catalog, under its name. */
export interface ServedGame {
  readonly name: string;
  readonly game: CatalogGame;
  /** One line for the log: where it came from. */
  readonly about: string;
}

/** The games to serve and what to release when the server stops. */
export interface GameSet {
  readonly rooms: RoomsApi;
  readonly games: readonly ServedGame[];
  close(): Promise<void>;
}

/** A listening room server. */
export interface ServeHandle {
  readonly port: number;
  /** The catalog names, in order. */
  readonly names: readonly string[];
  /** One line per game, for the log. */
  readonly about: readonly string[];
  /** Stop: close every room and the server. Twice is harmless. */
  close(): Promise<void>;
}

/**
 * @param options The resolved options.
 * @param joltWasm Jolt's wasm file. Default: the installed `jolt-physics`'s;
 *   the container bundle passes the copy beside itself (it has no node_modules).
 * @param env Where `GAMEABLE_PG_URL` is read. Default `process.env`.
 * @returns The listening server.
 * @throws {Error} When the player store cannot be migrated, a game cannot be
 *   loaded, or the bind fails (`code: 'EADDRINUSE'`...).
 */
export async function startServe(
  options: ServeOptions,
  joltWasm?: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<ServeHandle> {
  const wasm = joltWasm ?? createRequire(import.meta.url).resolve('jolt-physics/jolt-physics.wasm.wasm');
  // First: a store it cannot migrate stops the start before any game is loaded.
  const store = await (await import('@gameable/net/server')).storeFromEnv(env);
  let opened: GameSet;
  try {
    opened =
      options.mode === 'direct'
        ? await (await import('./directGame.js')).openDirectGame(options, wasm, store)
        : await (await import('./builtGame.js')).openBuiltGames(options, wasm, store);
  } catch (error) {
    await store.dispose();
    throw error;
  }
  const set: GameSet = { ...opened, close: () => opened.close().finally(() => store.dispose()) };
  return listen(set, options).catch(async (error: unknown) => {
    await set.close();
    throw error;
  });
}

/**
 * @param set The games.
 * @param options The resolved options.
 * @returns The listening server.
 */
async function listen(set: GameSet, options: ServeOptions): Promise<ServeHandle> {
  const games: Record<string, CatalogGame> = {};
  for (const { name, game } of set.games) {
    if (name in games) throw new Error(`two games are named "${name}"`);
    games[name] = game;
  }
  const server = set.rooms.createRoomServer({
    port: options.port,
    host: options.host,
    origins: options.origins,
    games,
    maxRooms: options.maxRooms,
    trustProxy: options.trustProxy,
  });
  let port: number;
  try {
    port = await server.listen();
  } catch (error) {
    await server.close().catch(() => undefined);
    throw error;
  }
  let closing: Promise<void> | null = null;
  return {
    port,
    names: set.games.map((g) => g.name),
    about: set.games.map((g) => g.about),
    close: () => (closing ??= server.close().finally(() => set.close())),
  };
}
