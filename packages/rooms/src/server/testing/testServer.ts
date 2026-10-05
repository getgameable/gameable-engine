/**
 * A real Colyseus server on port 0 for the room tests, the tiny game as a
 * room entry, and small waits. Task 3.8's `createRoomServer` is the real
 * host; this builds the minimal `Server` directly.
 */
import type { AddressInfo } from 'node:net';

import { createEngineRoomGame } from '@gameable/net/server';
import type { GameDefinition } from '@gameable/sdk';
import { matchMaker, Server } from '@colyseus/core';
import { WebSocketTransport } from '@colyseus/ws-transport';

import { GameableColyseusRoom } from '../GameableColyseusRoom.js';
import type { GameableRoomEntry, GameableRoomOptions } from '../GameableRoomEntry.js';
import { engineGame } from '../host/engineGame.js';
import type { CatalogGame } from '../host/RoomCatalog.js';
import type { TestPlayer } from './TestPlayer.js';

/** The assets the tiny game names; a headless engine never loads them. */
const MANIFEST = {
  version: 1,
  assets: [
    { id: 'arena', type: 'splat', src: 'a.spz' },
    { id: 'enemy-capsule', type: 'gltf', src: 'e.glb' },
    { id: 'shot', type: 'audio', src: 's.wav' },
  ],
};

/** @returns The tiny-game fixture's definition, loaded by URL. */
async function loadTinyGame(): Promise<GameDefinition> {
  const url = new URL('../../../../../fixtures/tiny-game/src/game.ts', import.meta.url);
  return ((await import(url.href)) as { default: GameDefinition }).default;
}

/**
 * The tiny game as a room entry: two seats, rows at 20 Hz. Gravity is off:
 * headless, the tiny game has no floor, so bodies would free-fall forever.
 *
 * @param overrides Entry fields to change (`reconnectSeconds`...).
 * @returns The entry.
 */
export function tinyEntry(overrides: Partial<GameableRoomEntry> = {}): GameableRoomEntry {
  return {
    maxPlayers: 2,
    sendHz: 20,
    create: async () =>
      createEngineRoomGame({
        definition: await loadTinyGame(),
        manifest: MANIFEST,
        maxPlayers: 2,
        seed: 7,
        physicsOptions: { gravity: [0, 0, 0] },
      }),
    ...overrides,
  };
}

/**
 * The tiny game for a room server, through `engineGame` as `gameable serve`
 * builds it: the definition declares two seats, gravity is off.
 *
 * @returns The catalog game.
 */
export async function tinyEngineGame(): Promise<CatalogGame> {
  const tiny = await loadTinyGame();
  const definition = { ...tiny, features: { ...tiny.features, multiplayer: { maxPlayers: 2 } } };
  return engineGame({
    definition,
    manifest: MANIFEST,
    seed: 7,
    physicsOptions: { gravity: [0, 0, 0] },
  });
}

/**
 * Limits for test files that make many rooms from one address: the per-address
 * limits have their own tests (`createRoomServer.limits.test.ts`, `.codes.test.ts`).
 */
export const OPEN_LIMITS = {
  creates: { burst: 1000, refillMs: 1 },
  misses: { burst: 1000, refillMs: 1 },
  globalMisses: { burst: 1000, refillMs: 1 },
  roomsPerAddress: 1000,
  lobbySocketsPerAddress: 1000,
  seatsPerAddress: 1000,
} as const;

/** A running test server. */
export interface TestServer {
  /** `ws://127.0.0.1:port`. */
  readonly endpoint: string;
  close(): Promise<void>;
}

/**
 * One server per test file: Colyseus's matchmaker is a process-wide singleton.
 *
 * @param rooms Room name to entry.
 * @param extra More define options for every room (`identities`).
 * @returns The listening server.
 */
export async function startTestServer(
  rooms: Record<string, GameableRoomEntry>,
  extra: Omit<GameableRoomOptions, 'entry'> = {},
): Promise<TestServer> {
  const transport = new WebSocketTransport();
  const server = new Server({ transport, greet: false, gracefullyShutdown: false });
  for (const [name, entry] of Object.entries(rooms))
    server.define(name, GameableColyseusRoom, { ...extra, entry });
  await server.listen(0, '127.0.0.1');
  const port = (transport.server?.address() as AddressInfo).port;
  return {
    endpoint: `ws://127.0.0.1:${String(port)}`,
    close: () => server.gracefullyShutdown(false),
  };
}

/**
 * @param roomId A room in this process.
 * @returns The room.
 */
export function localRoom(roomId: string): GameableColyseusRoom {
  const room = matchMaker.getLocalRoomById(roomId) as GameableColyseusRoom | undefined;
  if (room === undefined) throw new Error(`no local room ${roomId}`);
  return room;
}

/**
 * Wait until this process holds no room: a test file on the direct-mode tiny
 * game runs one room at a time (two direct rooms in one realm share the SDK's state).
 *
 * @param timeoutMs How long to wait.
 */
export async function noRoomsLeft(timeoutMs = 5000): Promise<void> {
  const until = Date.now() + timeoutMs;
  while ((await matchMaker.query({})).length > 0) {
    if (Date.now() > until) throw new Error('timed out waiting for the rooms to go');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/**
 * Kill a client's socket without a close handshake: the server sees 1006.
 *
 * @param roomId The room.
 * @param sessionId The client.
 */
export function killSocket(roomId: string, sessionId: string): void {
  const client = localRoom(roomId).clients.get(sessionId);
  if (client === undefined) throw new Error(`no client ${sessionId}`);
  (client.ref as unknown as { terminate(): void }).terminate();
}

/**
 * @param check The condition.
 * @param what Words for the failure.
 * @param timeoutMs How long to wait.
 */
export async function waitFor(check: () => boolean, what: string, timeoutMs = 5000): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/**
 * Hold keys for a while, one INPUT frame every 1000/60 ms, then let go.
 *
 * @param player The player.
 * @param keys DOM codes to hold.
 * @param ms How long.
 */
export async function holdFor(
  player: TestPlayer,
  keys: readonly string[],
  ms: number,
): Promise<void> {
  player.hold(keys);
  const timer = setInterval(() => {
    player.sendInput();
  }, 1000 / 60);
  await new Promise((resolve) => setTimeout(resolve, ms));
  clearInterval(timer);
  player.hold([]);
  player.sendInput();
}

/**
 * @param a A position.
 * @param b Another.
 * @returns The distance on the ground plane (x, z).
 */
export function groundDistance(a: ArrayLike<number>, b: ArrayLike<number>): number {
  return Math.hypot(a[0] - b[0], a[2] - b[2]);
}
