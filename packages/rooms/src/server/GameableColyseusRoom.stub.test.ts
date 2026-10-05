/**
 * The room against a stub `RoomGame` whose every answer names its player:
 * each player's welcome and frames are their own, floods are dropped, a game
 * that ends itself closes the room, rows go at `sendHz`, and held seats'
 * views are still taken. A real Colyseus server on port 0, `@colyseus/sdk` players.
 */
import { CloseCode, Protocol } from '@colyseus/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { StubGame, stubEntry } from './testing/StubGame.js';
import { TestPlayer } from './testing/TestPlayer.js';
import {
  killSocket,
  localRoom,
  startTestServer,
  type TestServer,
  waitFor,
} from './testing/testServer.js';

let server: TestServer;

beforeAll(async () => {
  server = await startTestServer({
    stub: stubEntry(),
    brief: stubEntry({ reconnectSeconds: 0.3 }),
  });
});

afterAll(async () => {
  await server.close();
});

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * @param name The room name.
 * @returns Two players in one fresh room of that name, both welcomed, and its stub game.
 */
async function pair(name = 'stub'): Promise<{ a: TestPlayer; b: TestPlayer; game: StubGame }> {
  const a = await TestPlayer.create(server.endpoint, name, { name: 'A' });
  const b = await TestPlayer.joinById(server.endpoint, a.room.roomId, {
    name: 'B',
    game: a.room.name,
  });
  await waitFor(() => a.replica.welcomes === 1 && b.replica.welcomes === 1, 'both welcomes');
  return { a, b, game: localRoom(a.room.roomId).game as StubGame };
}

describe('GameableColyseusRoom over a stub game', () => {
  it("gives each player their own welcome, cmd entity and rows, never player 0's", async () => {
    const { a, b, game } = await pair();
    expect(a.replica.snapshot).toMatchObject({ for: 0 });
    expect(b.replica.snapshot).toMatchObject({ for: 1 });
    expect(game.snapshots).toEqual([0, 1]); // each welcome reset only its own player's view
    await waitFor(() => a.replica.counts.rows > 2 && b.replica.counts.rows > 2, 'rows to both');
    expect([...a.replica.cmdEntities]).toEqual([100]);
    expect([...b.replica.cmdEntities]).toEqual([101]);
    expect([...a.replica.rowEntities]).toEqual([100]);
    expect([...b.replica.rowEntities]).toEqual([101]);
    await Promise.all([a.leave(), b.leave()]);
    await waitFor(() => game.leaves.length === 2, 'both leave');
    expect(game.leaves.map((l) => l.reason)).toEqual(['left', 'left']);
  });

  it('refuses a third player by id once full, and joinOrCreate makes a new room', async () => {
    const { a, b } = await pair();
    await expect(
      TestPlayer.joinById(server.endpoint, a.room.roomId, { name: 'C', game: a.room.name }),
    ).rejects.toThrow();
    const c = await TestPlayer.joinOrCreate(server.endpoint, 'stub', { name: 'C' });
    expect(c.room.roomId).not.toBe(a.room.roomId);
    await Promise.all([a.leave(), b.leave(), c.leave()]);
  });

  it('sends rows at sendHz (20) while cmd goes every tick (60)', async () => {
    const { a, b } = await pair();
    const rows0 = a.replica.counts.rows;
    const cmd0 = a.replica.counts.cmd;
    await sleep(1000);
    const rows = a.replica.counts.rows - rows0;
    const cmd = a.replica.counts.cmd - cmd0;
    expect(cmd).toBeGreaterThan(45);
    expect(rows).toBeGreaterThan(12);
    expect(rows).toBeLessThan(28);
    await Promise.all([a.leave(), b.leave()]);
  });

  it("takes a held seat's view every tick, so nothing piles up", async () => {
    const { a, b, game } = await pair();
    killSocket(a.room.roomId, a.room.sessionId);
    await waitFor(() => b.replica.players.find((p) => p.id === 0)?.connected === false, 'A held');
    const held0 = game.views.get(0) ?? 0;
    const live0 = game.views.get(1) ?? 0;
    await sleep(300);
    const held = (game.views.get(0) ?? 0) - held0;
    const live = (game.views.get(1) ?? 0) - live0;
    expect(live).toBeGreaterThan(10);
    expect(Math.abs(held - live)).toBeLessThanOrEqual(1);
    await b.leave();
  });

  it('drops an INPUT flood with error: budget and frees the seat at once', async () => {
    const { a, b, game } = await pair();
    for (let i = 0; i < 130; i += 1) a.sendInput(); // the input budget is 120
    await waitFor(() => a.leftWith !== null, 'A dropped');
    expect(a.replica.errors).toContainEqual({ code: 'budget', detail: undefined });
    expect(a.leftWith).toBe(CloseCode.WITH_ERROR);
    await waitFor(() => game.leaves.length === 1, 'A leaves the game');
    expect(game.leaves).toEqual([{ player: 0, reason: 'budget' }]);
    await waitFor(() => b.replica.players.length === 1, 'B sees A gone');
    await b.leave();
  });

  it("drops a flood of Colyseus's own frames (PING) and frees the seat at once", async () => {
    const { a, b, game } = await pair();
    const ping = new Uint8Array([Protocol.PING]);
    for (let i = 0; i < 300; i += 1) a.sendRaw(ping);
    await waitFor(() => a.leftWith !== null, 'A dropped');
    expect(a.leftWith).toBe(CloseCode.WITH_ERROR);
    await waitFor(() => game.leaves.length === 1, 'A leaves the game');
    expect(game.leaves).toEqual([{ player: 0, reason: 'flood' }]);
    await b.leave();
  });

  it('closes the room when the game ends itself: error: ended with the reason, to everyone', async () => {
    const { a, b, game } = await pair();
    game.crash('crashed');
    await waitFor(() => a.leftWith !== null && b.leftWith !== null, 'both closed');
    for (const p of [a, b])
      expect(p.replica.errors).toContainEqual({ code: 'ended', detail: 'crashed' });
    await waitFor(() => game.disposed, 'the game disposed');
  });

  it("lets a held seat go with 'timeout', cuts names to 32, and ignores a client's own entry", async () => {
    const a = await TestPlayer.create(server.endpoint, 'brief', {
      name: 'x'.repeat(50),
      entry: { maxPlayers: 99, reconnectSeconds: 999 },
    });
    await waitFor(() => a.replica.welcomes === 1, 'the welcome');
    const room = localRoom(a.room.roomId);
    const game = room.game as StubGame;
    expect(room.maxClients).toBe(2);
    expect(game.joins[0].name).toBe('x'.repeat(32));
    killSocket(a.room.roomId, a.room.sessionId);
    await waitFor(() => game.leaves.length === 1, 'the hold expires', 3000);
    expect(game.leaves).toEqual([{ player: 0, reason: 'timeout' }]);
  });
});
