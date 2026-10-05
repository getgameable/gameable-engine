/**
 * A dropped seat is held, and the game hears it (`RoomGame.hold`, then
 * `resume` when the player is back): an engine game leaves a held seat out of
 * the guest's players list, which is how the SDK moves the host off a player
 * who dropped.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { type StubGame, stubEntry } from './testing/StubGame.js';
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
  server = await startTestServer({ stub: stubEntry() });
});

afterAll(async () => {
  await server.close();
});

describe('GameableColyseusRoom: a held seat', () => {
  it('tells the game when a seat is held and when its player is back', async () => {
    const a = await TestPlayer.create(server.endpoint, 'stub', { name: 'A' });
    const b = await TestPlayer.joinById(server.endpoint, a.room.roomId, {
      name: 'B',
      game: 'stub',
    });
    await waitFor(() => a.replica.welcomes === 1 && b.replica.welcomes === 1, 'both welcomes');
    const game = localRoom(a.room.roomId).game as StubGame;
    const token = a.room.reconnectionToken;

    killSocket(a.room.roomId, a.room.sessionId);
    await waitFor(() => game.holds.length === 1, 'the hold');
    expect(game.holds).toEqual([0]);
    expect(game.leaves).toEqual([]); // held, not left
    expect(game.resumes).toEqual([]);

    await a.reconnect(token);
    await waitFor(() => game.resumes.length === 1, 'the resume');
    expect(game.resumes).toEqual([0]);
    await Promise.all([a.leave(), b.leave()]);
  });
});
