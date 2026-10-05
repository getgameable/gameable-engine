/**
 * Task 4.2 on the Colyseus room: a `msg` over the payload cap is dropped
 * and counted per player; a player out of text budget is told
 * `error: budget` once and keeps the seat; sustained abuse closes it with
 * 4002 and frees the seat. A real Colyseus server on port 0, `@colyseus/sdk` players.
 */
import { MAX_PAYLOAD_BYTES } from '@gameable/sdk/wire';
import { CloseCode } from '@colyseus/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { type StubGame, stubEntry } from './testing/StubGame.js';
import { TestPlayer } from './testing/TestPlayer.js';
import { localRoom, startTestServer, type TestServer, waitFor } from './testing/testServer.js';

let server: TestServer;

beforeAll(async () => {
  server = await startTestServer({
    stub: stubEntry(),
    tight: stubEntry({
      budgets: { text: { burst: 3, refill: 1, everyMs: 60_000, closeAfter: 5 } },
    }),
  });
});

afterAll(async () => {
  await server.close();
});

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const msg = (n: number): string => `{"t":"msg","name":"chat","payload":${String(n)}}`;

/**
 * @param name The room name.
 * @returns Two players in one fresh room of that name, both welcomed, and its stub game.
 */
async function pair(name: string): Promise<{ a: TestPlayer; b: TestPlayer; game: StubGame }> {
  const a = await TestPlayer.create(server.endpoint, name, { name: 'A' });
  const b = await TestPlayer.joinById(server.endpoint, a.room.roomId, {
    name: 'B',
    game: a.room.name,
  });
  await waitFor(() => a.replica.welcomes === 1 && b.replica.welcomes === 1, 'both welcomes');
  return { a, b, game: localRoom(a.room.roomId).game as StubGame };
}

describe('GameableColyseusRoom: text limits', () => {
  it('drops a msg over MAX_PAYLOAD_BYTES and counts it against that player only', async () => {
    const { a, b, game } = await pair('stub');
    a.sendText(`{"t":"msg","name":"chat","payload":"${'a'.repeat(MAX_PAYLOAD_BYTES)}"}`);
    a.sendText(msg(1));
    await waitFor(() => game.messages.length === 1, 'the small msg');
    expect(game.messages).toEqual([{ player: 0, name: 'chat', payload: '1' }]);
    const seats = localRoom(a.room.roomId).seats.list();
    expect(seats.map((s) => s.text.counts.oversize)).toEqual([1, 0]);
    expect(a.replica.errors).toEqual([]);
    await Promise.all([a.leave(), b.leave()]);
  });

  it('tells a player out of text budget once, drops the rest, and keeps the seat', async () => {
    const { a, b, game } = await pair('tight');
    for (let i = 0; i < 6; i += 1) a.sendText(msg(i)); // 3 pass, 3 refused (closeAfter is 5)
    b.sendText(msg(9)); // B's budget is his own
    await waitFor(() => game.messages.length === 4, 'the messages within budget');
    await waitFor(() => a.replica.errors.length > 0, 'A told');
    await sleep(200);
    expect(game.messages.map((m) => `${String(m.player)} ${m.payload}`).sort()).toEqual([
      '0 0',
      '0 1',
      '0 2',
      '1 9',
    ]);
    expect(a.replica.errors).toEqual([{ code: 'budget', detail: undefined }]);
    expect(b.replica.errors).toEqual([]);
    expect(a.leftWith).toBeNull();
    expect(game.leaves).toEqual([]);
    expect(localRoom(a.room.roomId).seats.get(a.room.sessionId)?.text.counts.overBudget).toBe(3);
    await Promise.all([a.leave(), b.leave()]);
  });

  it('closes sustained abuse with 4002, told once, and frees the seat at once', async () => {
    const { a, b, game } = await pair('tight');
    for (let i = 0; i < 3 + 5; i += 1) a.sendText(msg(i));
    await waitFor(() => a.leftWith !== null, 'A dropped');
    expect(a.leftWith).toBe(CloseCode.WITH_ERROR);
    expect(a.replica.errors).toEqual([{ code: 'budget', detail: undefined }]);
    await waitFor(() => game.leaves.length === 1, 'A leaves the game');
    expect(game.leaves).toEqual([{ player: 0, reason: 'budget' }]);
    await waitFor(() => b.replica.players.length === 1, 'B sees A gone');
    await b.leave();
  });

  it('at the default limits (40, +20 per 5 s, 100), our rule closes before the 200/s backstop', async () => {
    const { a, b, game } = await pair('stub');
    for (let i = 0; i < 60; i += 1) a.sendText(msg(i));
    await waitFor(() => a.replica.errors.length > 0, 'A told');
    await sleep(200);
    expect(a.leftWith).toBeNull(); // 20 over budget: told, not closed
    for (let i = 0; i < 80; i += 1) a.sendText(msg(i)); // 100 in a row now
    await waitFor(() => a.leftWith !== null, 'A dropped');
    expect(a.replica.errors).toEqual([{ code: 'budget', detail: undefined }]);
    await waitFor(() => game.leaves.length === 1, 'A leaves the game');
    expect(game.leaves).toEqual([{ player: 0, reason: 'budget' }]); // ours, not 'flood'
    await b.leave();
  });
});
