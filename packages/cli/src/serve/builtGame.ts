/**
 * `serve` without `--direct`: built games, each its wasm guest (`dist/guest/`)
 * and its server bundle (`dist/server/`), up to `--max-rooms` rooms in all.
 * No TypeScript and no Vite: this is what the container runs.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

import type { PlayerStore } from '@gameable/net/server';
import * as rooms from '@gameable/rooms/server';
import type { GameDefinition } from '@gameable/sdk';

import { readFileAsset } from './manifestFiles.js';
import { roomSeeds, type ServeOptions } from './options.js';
import { GAME_JSON, SERVER_DIR, SERVER_MANIFEST, type ServerGameJson } from './serverGame.js';
import type { GameSet, ServedGame } from './startServe.js';

/**
 * @param options The resolved options.
 * @returns The `dist/` folders to serve: every `<gamesDir>/<name>/dist` holding a server bundle, or the game's own.
 * @throws {Error} When there is nothing to serve.
 */
export function builtDistDirs(options: ServeOptions): string[] {
  const has = (dist: string): boolean => existsSync(`${dist}/${SERVER_DIR}/${GAME_JSON}`);
  if (options.gamesDir === undefined) {
    const dist = `${options.gameDir}/dist`;
    if (!has(dist)) {
      throw new Error(
        `${dist}/${SERVER_DIR}/${GAME_JSON} is missing: run gameable build first (a game that declares ` +
          'features.multiplayer gets a server bundle), or serve the sources with --direct',
      );
    }
    return [dist];
  }
  const root = options.gamesDir;
  const found = existsSync(root)
    ? readdirSync(root, { withFileTypes: true })
        .filter((e) => e.isDirectory() && has(`${root}/${e.name}/dist`))
        .map((e) => `${root}/${e.name}/dist`)
        .sort()
    : [];
  if (found.length === 0) throw new Error(`no built game under ${root}: expected ${root}/<name>/dist/${SERVER_DIR}/${GAME_JSON}`);
  return found;
}

/**
 * @param dist A game's `dist/` folder.
 * @param options The resolved options.
 * @param joltWasm Jolt's wasm file.
 * @param store The player store, or none.
 * @returns The game for the catalog.
 * @throws {Error} When the guest is missing, or `game.json` disagrees with itself.
 */
export function loadBuiltGame(dist: string, options: ServeOptions, joltWasm: string, store?: PlayerStore): ServedGame {
  const serverDir = `${dist}/${SERVER_DIR}`;
  const json = JSON.parse(readFileSync(`${serverDir}/${GAME_JSON}`, 'utf8')) as ServerGameJson;
  const guestEntry = `${dist}/guest/game.js`;
  if (!existsSync(guestEntry)) throw new Error(`${guestEntry} is missing: the wasm guest is built by gameable build`);
  const manifestPath = `${serverDir}/${SERVER_MANIFEST}`;
  const manifest = existsSync(manifestPath)
    ? { ...(JSON.parse(readFileSync(manifestPath, 'utf8')) as object), baseUrl: `${pathToFileURL(serverDir).href}/` }
    : undefined;
  // Features do not cross the WIT boundary: game.json carries them, and they are all a host reads.
  const definition = { features: json.features } as GameDefinition;
  const game = rooms.engineGame({
    definition,
    guest: { guestModuleUrl: pathToFileURL(guestEntry).href, getCoreModule: coreModules(`${dist}/guest`) },
    manifest,
    readAsset: readFileAsset,
    physicsOptions: { ...json.physics, wasmUrl: joltWasm },
    seed: roomSeeds(options.seed),
    ...(store === undefined ? {} : { data: { store, game: json.name } }),
  });
  if (game.maxPlayers !== json.maxPlayers || game.sendHz !== json.sendHz) {
    throw new Error(`${serverDir}/${GAME_JSON}: maxPlayers and sendHz disagree with its features; rebuild it`);
  }
  const about = `${json.name}: ${dist} (wasm), ${String(json.maxPlayers)} seats, rows at ${String(json.sendHz)} Hz`;
  return { name: json.name, game, about };
}

/**
 * @param guestDir The transpiled guest's folder.
 * @returns A loader that compiles each core module once and shares it across rooms.
 */
function coreModules(guestDir: string): (path: string) => Promise<WebAssembly.Module> {
  const cache = new Map<string, Promise<WebAssembly.Module>>();
  return (path) => {
    let pending = cache.get(path);
    if (pending === undefined) {
      pending = readFile(`${guestDir}/${path}`).then((bytes) => WebAssembly.compile(bytes));
      cache.set(path, pending);
    }
    return pending;
  };
}

/**
 * @param options The resolved options (`mode: 'built'`).
 * @param joltWasm Jolt's wasm file.
 * @param store The player store, or none.
 * @returns The built games.
 */
export function openBuiltGames(options: ServeOptions, joltWasm: string, store?: PlayerStore): Promise<GameSet> {
  const games = builtDistDirs(options).map((dist) => loadBuiltGame(dist, options, joltWasm, store));
  return Promise.resolve({ rooms, games, close: () => Promise.resolve() });
}
