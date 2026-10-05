/**
 * A catalog built beforehand still gets the server's `leaveAfterMs` (phase 3
 * review M4): a game that sets no hold of its own is held for the server's
 * time, not the catalog's 30 s default.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { stubGame } from '../testing/StubGame.js';
import { TestPlayer } from '../testing/TestPlayer.js';
import { killSocket, localRoom, waitFor } from '../testing/testServer.js';
import { createRoomServer, type RoomServer } from './createRoomServer.js';
import { createRoomCatalog } from './RoomCatalog.js';

const ORIGIN = 'http://game.test';
let server: RoomServer;
let endpoint: string;

beforeAll(async () => {
  const catalog = createRoomCatalog({ stub: stubGame(), own: stubGame({ reconnectSeconds: 30 }) });
  server = createRoomServer({ port: 0, origins: [ORIGIN], games: catalog, leaveAfterMs: 300 });
  endpoint = `ws://127.0.0.1:${String(await server.listen())}`;
});

afterAll(async () => {
  await server.close();
});

describe('createRoomServer with a prebuilt catalog', () => {
  it("holds a dropped seat for the server's leaveAfterMs", async () => {
    const a = await TestPlayer.create(endpoint, 'stub', { name: 'A' }, { origin: ORIGIN });
    const b = await TestPlayer.joinById(endpoint, a.room.roomId, { name: 'B', game: 'stub' }, { origin: ORIGIN });
    const room = localRoom(a.room.roomId);
    killSocket(a.room.roomId, a.room.sessionId);
    await waitFor(() => room.players === 1, 'the 300 ms hold to expire', 3000);
    await b.leave();
  });

  it("keeps a game's own hold over the server's", () => {
    expect(server.catalog.entry('own').reconnectSeconds).toBe(30);
    expect(server.catalog.entry('stub', { reconnectSeconds: 0.3 }).reconnectSeconds).toBe(0.3);
    expect(server.catalog.entry('own', { reconnectSeconds: 0.3 }).reconnectSeconds).toBe(30);
  });
});
