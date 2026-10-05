/**
 * Crash isolation (3.7 review I4, 3.8 review I4): a throw in one room's
 * `game.tick`, message handler, welcome or `leave` (a consented leave, or a
 * held seat that expires) closes that room only, with `crashed`, tells its
 * players, never calls that game again, and every other room keeps running.
 * Nothing reaches the process.
 */
import { afterAll, beforeAll, describe, expect, it, type MockInstance, vi } from 'vitest';

import type { StubGame } from '../testing/StubGame.js';
import { stubGame } from '../testing/StubGame.js';
import { TestPlayer } from '../testing/TestPlayer.js';
import { killSocket, localRoom, OPEN_LIMITS, waitFor } from '../testing/testServer.js';
import { createRoomServer, type RoomServer } from './createRoomServer.js';

const HEADERS = { origin: 'http://game.test' };
let server: RoomServer;
let endpoint: string;
let errors: MockInstance<typeof console.error>;

beforeAll(async () => {
  errors = vi.spyOn(console, 'error').mockImplementation(() => undefined); // the crash logs are expected
  server = createRoomServer({
    port: 0,
    origins: [HEADERS.origin],
    games: { stub: stubGame(), brief: stubGame({ reconnectSeconds: 0.3 }) },
    limits: OPEN_LIMITS,
  });
  endpoint = `ws://127.0.0.1:${String(await server.listen())}`;
});

afterAll(async () => {
  await server.close();
  vi.restoreAllMocks();
});

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** @returns The process guard's lines: something no room caught. */
const processLevel = (): unknown[][] =>
  errors.mock.calls.filter((call) => /unhandled rejection|uncaught exception/.test(String(call[0])));

/**
 * @param victimRoom The name of the room that will crash.
 * @returns Two rooms of one welcomed player each, and their games.
 */
async function twoRooms(
  victimRoom = 'stub',
): Promise<{ a: TestPlayer; b: TestPlayer; ga: StubGame; gb: StubGame }> {
  await waitFor(() => server.health().rooms === 0, 'earlier rooms to go');
  const a = await TestPlayer.create(endpoint, victimRoom, { name: 'A' }, HEADERS);
  const b = await TestPlayer.create(endpoint, 'stub', { name: 'B' }, HEADERS);
  await waitFor(() => a.replica.welcomes === 1 && b.replica.welcomes === 1, 'both welcomes');
  const ga = localRoom(a.room.roomId).game as StubGame;
  const gb = localRoom(b.room.roomId).game as StubGame;
  return { a, b, ga, gb };
}

/**
 * @param victim The crashed room's game.
 * @param survivor The other room's player.
 * @param game The other room's game.
 */
async function expectIsolated(victim: StubGame, survivor: TestPlayer, game: StubGame): Promise<void> {
  await waitFor(() => server.health().rooms === 1, 'only the crashed room to go');
  expect(victim.callsAfterFault).toBe(0); // a crashed game is never called again
  const frame = game.frame;
  const cmds = survivor.replica.counts.cmd;
  await sleep(200);
  expect(game.frame - frame).toBeGreaterThan(6); // still ticking at 60 Hz
  expect(survivor.replica.counts.cmd - cmds).toBeGreaterThan(6); // and still sending
  expect(survivor.leftWith).toBeNull();
  expect(survivor.replica.errors).toEqual([]);
  expect(game.disposed).toBe(false);
  expect(processLevel()).toEqual([]);
  await survivor.leave();
}

/** @param player The crashed room's player: closed with `crashed`. */
async function expectCrashed(player: TestPlayer): Promise<void> {
  await waitFor(() => player.leftWith !== null, 'the crashed room to close its player');
  expect(player.replica.errors).toContainEqual({ code: 'ended', detail: 'crashed' });
}

describe('createRoomServer: one room crashes, the rest run', () => {
  it('closes the room whose game.tick throws', async () => {
    const { a, b, ga, gb } = await twoRooms();
    ga.fault = 'tick';
    await expectCrashed(a);
    await expectIsolated(ga, b, gb);
    expect(ga.disposed).toBe(true);
    expect(ga.leaves).toEqual([]); // onLeave did not call the crashed game
  });

  it('closes the room whose message handler throws', async () => {
    const { a, b, ga, gb } = await twoRooms();
    ga.fault = 'message';
    a.sendText('{"t":"msg","name":"boom","payload":{}}');
    await expectCrashed(a);
    await expectIsolated(ga, b, gb);
  });

  it('closes the room whose welcome throws, and tells the player who was joining', async () => {
    const { a, b, ga, gb } = await twoRooms();
    ga.fault = 'welcome';
    const joiner = await TestPlayer.joinById(endpoint, a.room.roomId, { name: 'J', game: a.room.name }, HEADERS);
    await expectCrashed(joiner);
    await expectCrashed(a);
    await expectIsolated(ga, b, gb);
  });

  it('closes the room whose leave throws when a held seat expires, outside any Colyseus try', async () => {
    const { a, b, ga, gb } = await twoRooms('brief');
    const c = await TestPlayer.joinById(endpoint, a.room.roomId, { name: 'C', game: a.room.name }, HEADERS);
    await waitFor(() => c.replica.welcomes === 1, "C's welcome");
    ga.fault = 'leave';
    killSocket(a.room.roomId, a.room.sessionId); // 1006: held for 0.3 s, then game.leave
    await expectCrashed(c);
    await expectIsolated(ga, b, gb);
  });

  it('closes the room whose leave throws on a consented leave', async () => {
    const { a, b, ga, gb } = await twoRooms();
    const c = await TestPlayer.joinById(endpoint, a.room.roomId, { name: 'C', game: a.room.name }, HEADERS);
    await waitFor(() => c.replica.welcomes === 1, "C's welcome");
    ga.fault = 'leave';
    await a.leave();
    await expectCrashed(c);
    await expectIsolated(ga, b, gb);
  });

  it('frees the slot of a room whose game.dispose throws', async () => {
    await waitFor(() => server.health().rooms === 0, 'earlier rooms to go');
    const a = await TestPlayer.create(endpoint, 'stub', { name: 'A' }, HEADERS);
    (localRoom(a.room.roomId).game as StubGame).fault = 'dispose';
    await a.leave();
    await waitFor(() => server.health().rooms === 0, 'the slot back despite the throw');
    expect(processLevel()).toEqual([]);
  });

  it('frees the crashed rooms for the cap and the codes: the server keeps making rooms', async () => {
    await waitFor(() => server.health().rooms === 0, 'earlier rooms to go');
    const c = await TestPlayer.create(endpoint, 'stub', { name: 'C' }, HEADERS);
    await waitFor(() => c.replica.welcomes === 1, 'a new room after the crashes');
    expect(server.health()).toMatchObject({ rooms: 1, players: 1 });
    await c.leave();
  });
});
