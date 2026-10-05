/**
 * A real room server for the client tests: `createRoomServer` on port 0 with
 * the tiny game's two-seat module built to a wasm guest (production rooms are
 * wasm), and the page side as real `multiplayer()` clients over
 * `ColyseusConnection`. Not exported.
 */
import { mkdirSync, rmSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pathToFileURL } from 'node:url';

import type { NetClient } from '@gameable/net/client';
import type { NetModule } from '@gameable/net/client';
import type { GameDefinition } from '@gameable/sdk';

import { createRoomServer, type RoomServer } from '../../server/host/createRoomServer.js';
import { engineGame } from '../../server/host/engineGame.js';
import { OPEN_LIMITS } from '../../server/testing/testServer.js';
import { multiplayer, type RoomsMultiplayerOptions } from '../module.js';
import type { SeatStorage } from '../SeatTokens.js';

/** The page origin the test server allows. */
export const ORIGIN = 'http://game.test';

/** The assets the tiny game names; a headless engine never loads them. */
const MANIFEST = {
  version: 1,
  assets: ['arena', 'enemy-capsule', 'shot'].map((id) => ({ id, type: 'gltf', src: `${id}.glb` })),
};

interface FixtureBuild {
  buildTinyGame(options: { quiet?: boolean; game?: string }): {
    guestDir: string;
    guestEntry: string;
  };
}

/**
 * Run `fn` holding a directory lock: the two client test files build the same
 * fixture, possibly at once in two workers. A lock older than 2 minutes is a
 * dead worker's and is broken.
 *
 * @param dir The lock directory.
 * @param fn The work.
 * @returns What `fn` returns.
 */
async function locked<T>(dir: string, fn: () => T): Promise<T> {
  // dirname, never `${dir}/..`: on Linux a recursive mkdir of `lock/..`
  // creates `lock` itself on the way, and the lock is then never free.
  mkdirSync(dirname(dir), { recursive: true });
  for (;;) {
    try {
      mkdirSync(dir);
      break;
    } catch {
      const since = statSync(dir, { throwIfNoEntry: false })?.mtimeMs ?? Date.now();
      if (Date.now() - since > 120_000) rmSync(dir, { force: true, recursive: true });
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  try {
    return fn();
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
}

/**
 * Build (when stale) and load the two-seat tiny game: its definition, for the
 * seats, and its wasm guest, which each room runs.
 *
 * @returns The catalog game.
 */
async function twoSeatGame(): Promise<ReturnType<typeof engineGame>> {
  const fixture = new URL('../../../../../fixtures/tiny-game/', import.meta.url);
  const build = (await import(new URL('scripts/build.mjs', fixture).href)) as FixtureBuild;
  const lock = `${fileURLToPath(new URL('build', fixture))}/.twoSeats.lock`;
  const { guestDir, guestEntry } = await locked(lock, () =>
    build.buildTinyGame({ quiet: true, game: 'twoSeats' }),
  );
  const definition = (
    (await import(new URL('src/twoSeats.ts', fixture).href)) as { default: GameDefinition }
  ).default;
  return engineGame({
    definition,
    guest: {
      guestModuleUrl: pathToFileURL(guestEntry).href,
      getCoreModule: async (path) => WebAssembly.compile(await readFile(`${guestDir}/${path}`)),
    },
    manifest: MANIFEST,
    seed: 7,
    physicsOptions: { gravity: [0, 0, 0] }, // headless, the tiny game has no floor
  });
}

/** A listening server and its address. */
export interface WasmRooms {
  readonly server: RoomServer;
  /** `http://127.0.0.1:port`: the endpoint a page passes as `url`. */
  readonly url: string;
}

/**
 * @param leaveAfterMs How long a dropped seat is held.
 * @returns The server, listening; one per test file (the matchmaker is a process singleton).
 */
export async function startWasmRooms(leaveAfterMs = 30_000): Promise<WasmRooms> {
  const server = createRoomServer({
    port: 0,
    origins: [ORIGIN],
    games: { tiny: await twoSeatGame() },
    leaveAfterMs,
    limits: OPEN_LIMITS,
  });
  const port = await server.listen();
  return { server, url: `http://127.0.0.1:${String(port)}` };
}

/** An in-memory `sessionStorage`: one per simulated tab. */
export class MemoryStorage implements SeatStorage {
  readonly items = new Map<string, string>();

  getItem(key: string): string | null {
    return this.items.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.items.set(key, value);
  }

  removeItem(key: string): void {
    this.items.delete(key);
  }
}

/** One page: its `net` service and the `multiplayer()` feature it came from. */
export interface TestPage {
  readonly net: NetClient;
  readonly module: NetModule;
}

/**
 * Load `multiplayer()` as a page does and start it: the module's `init`,
 * then `start`, as the page's client loop does once it is attached.
 *
 * @param rooms The server.
 * @param options The page's options; `url`, `game`, `headers` and `maxPlayers` are filled in.
 * @returns The page.
 */
export async function openPage(
  rooms: WasmRooms,
  options: RoomsMultiplayerOptions = {},
): Promise<TestPage> {
  const feature = await multiplayer({
    url: rooms.url,
    game: 'tiny',
    maxPlayers: 2,
    headers: { origin: ORIGIN },
    storage: new MemoryStorage(),
    ...options,
  });
  const module = feature.modules[0] as NetModule;
  const net = module.init();
  net.start();
  return { net, module };
}

/**
 * @param check The condition.
 * @param what Words for the failure.
 * @param timeoutMs How long to wait.
 */
export async function waitFor(check: () => boolean, what: string, timeoutMs = 8000): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
