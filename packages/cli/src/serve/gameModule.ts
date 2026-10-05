/**
 * Load a game's `src/game.ts` on Node through the game's own Vite (its
 * config, so its `gameable()` plugin's resolve conditions apply), plus the
 * physics options the page uses, from `src/physicsOptions.ts`.
 */
import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import type { GameDefinition } from '@gameable/sdk';

import { resolvePackageFile } from '../lib/paths.js';

/**
 * Jolt's options as plain data: what `physics()` takes on the page, minus the
 * page-only `wasmUrl`. Kept loose on purpose, so `game.json` can carry it.
 */
export type PhysicsData = Readonly<Record<string, unknown>>;

/** A game's definition and its physics options, loaded on this host. */
export interface GameModule {
  readonly definition: GameDefinition;
  readonly physics: PhysicsData;
  /** Where the physics options came from, for the log line. */
  readonly physicsFrom: string;
}

/** The part of Vite this file uses. */
export interface ViteServer {
  ssrLoadModule(url: string): Promise<Record<string, unknown>>;
  close(): Promise<void>;
}

/** The convention: one module the page and every host import. */
export const PHYSICS_OPTIONS_FILE = 'src/physicsOptions.ts';

/**
 * A Vite server for the game, in middleware mode: a module graph on this
 * host, so the game and the engine packages it is handed to share one copy
 * of each package (two copies of the SDK would mean two sets of component
 * stores).
 *
 * @param gameDir The game's directory.
 * @returns The server; `close()` it when done.
 * @throws {Error} When Vite is not installed in the game.
 */
export async function openGameVite(gameDir: string): Promise<ViteServer> {
  const vitePath = resolvePackageFile(gameDir, 'vite', 'dist/node/index.js');
  if (vitePath === undefined) throw new Error(`vite is not installed in ${gameDir}; run npm install`);
  const vite = (await import(pathToFileURL(vitePath).href)) as {
    createServer(config: object): Promise<ViteServer>;
    defaultServerConditions: readonly string[];
  };
  return vite.createServer({
    root: gameDir,
    logLevel: 'error',
    appType: 'custom',
    server: { middlewareMode: true, hmr: false, ws: false, watch: null },
    optimizeDeps: { noDiscovery: true, include: [] },
    plugins: [sourceConditionsOnServer(vite.defaultServerConditions)],
  });
}

/**
 * The game's `gameable()` plugin sets `resolve.conditions`, which Vite applies to
 * the page only. Running the game on this host is the server environment, so
 * hand it the same `gameable-source` condition when the page has it.
 *
 * @param serverDefaults Vite's own server conditions, kept after ours.
 * @returns A Vite plugin, run after the game's own.
 */
function sourceConditionsOnServer(serverDefaults: readonly string[]): object {
  return {
    name: 'gameable-serve:server-conditions',
    enforce: 'post',
    config(config: { resolve?: { conditions?: unknown } }) {
      const page = config.resolve?.conditions;
      if (!Array.isArray(page) || !page.includes('gameable-source')) return undefined;
      return { ssr: { resolve: { conditions: ['gameable-source', ...serverDefaults] } } };
    },
  };
}

/**
 * @param server The game's Vite server.
 * @param gameDir The game's directory.
 * @returns The definition and physics options.
 * @throws {Error} When `src/game.ts` has no default export, or the physics module no `PHYSICS_OPTIONS`.
 */
export async function readGameModule(server: ViteServer, gameDir: string): Promise<GameModule> {
  const game = await server.ssrLoadModule('/src/game.ts');
  const definition = game.default as GameDefinition | undefined;
  if (definition === undefined || typeof definition !== 'object') {
    throw new Error(`${gameDir}/src/game.ts has no default export (export default defineGame({...}))`);
  }
  if (existsSync(`${gameDir}/${PHYSICS_OPTIONS_FILE}`)) {
    const module = await server.ssrLoadModule(`/${PHYSICS_OPTIONS_FILE}`);
    const options = module.PHYSICS_OPTIONS as PhysicsData | undefined;
    if (options === undefined) throw new Error(`${PHYSICS_OPTIONS_FILE} does not export PHYSICS_OPTIONS`);
    return { definition, physics: plain(options), physicsFrom: PHYSICS_OPTIONS_FILE };
  }
  // No shared module: the definition's own gravity is the one number both sides read.
  const gravity = definition.world?.gravity;
  return {
    definition,
    physics: gravity === undefined ? {} : { gravity: [0, gravity, 0] },
    physicsFrom: gravity === undefined ? 'physics-jolt defaults' : 'world.gravity in src/game.ts',
  };
}

/**
 * @param gameDir The game's directory.
 * @returns The definition and physics options, Vite closed again.
 */
export async function loadGameModule(gameDir: string): Promise<GameModule> {
  const server = await openGameVite(gameDir);
  try {
    return await readGameModule(server, gameDir);
  } finally {
    await server.close();
  }
}

/**
 * @param options The module's export.
 * @returns A JSON copy without `wasmUrl` (where Jolt's wasm lives is the host's business).
 */
function plain(options: PhysicsData): PhysicsData {
  const copy = JSON.parse(JSON.stringify(options)) as Record<string, unknown>;
  delete copy.wasmUrl;
  return copy;
}
