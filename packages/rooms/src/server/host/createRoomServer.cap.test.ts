/**
 * The per-process room cap (8 by default, from the Jolt measurement): the
 * ninth create is refused with a clear error, and a freed slot is reusable.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { stubGame } from '../testing/StubGame.js';
import { TestPlayer } from '../testing/TestPlayer.js';
import { OPEN_LIMITS, waitFor } from '../testing/testServer.js';
import { createRoomServer, type RoomServer } from './createRoomServer.js';

const HEADERS = { origin: 'http://game.test' };
const stub = stubGame();
let server: RoomServer;
let endpoint: string;

beforeAll(async () => {
  server = createRoomServer({
    port: 0,
    origins: [HEADERS.origin],
    games: { stub, broken: stubGame({ create: () => Promise.reject(new Error('build failed')) }) },
    limits: OPEN_LIMITS,
  });
  endpoint = `ws://127.0.0.1:${String(await server.listen())}`;
});

afterAll(async () => {
  await server.close();
});

describe('createRoomServer: maxRooms', () => {
  it('frees the slot of every failed build: nine failures, then a good room', async () => {
    for (let i = 0; i < 9; i += 1) {
      const create = TestPlayer.create(endpoint, 'broken', { name: 'x' }, HEADERS);
      await expect(create).rejects.toThrow(/build failed/);
    }
    expect(server.health().rooms).toBe(0);
    const good = await TestPlayer.create(endpoint, 'stub', { name: 'good' }, HEADERS);
    expect(server.health().rooms).toBe(1);
    await good.leave();
    await waitFor(() => server.health().rooms === 0, 'the good room to go');
    stub.games.length = 0;
  });

  it('refuses the ninth room with a capacity error and builds no game for it', async () => {
    const players: TestPlayer[] = [];
    for (let i = 0; i < 8; i += 1)
      players.push(await TestPlayer.create(endpoint, 'stub', { name: `p${String(i)}` }, HEADERS));
    expect(server.health().rooms).toBe(8);
    expect(stub.games).toHaveLength(8);

    const ninth = TestPlayer.create(endpoint, 'stub', { name: 'ninth' }, HEADERS);
    await expect(ninth).rejects.toThrow(/capacity: 8 rooms/);
    // A full server still seats a quick match into a room with a free seat.
    const quick = await TestPlayer.joinOrCreate(endpoint, 'stub', { name: 'q' }, HEADERS);
    expect(players.map((p) => p.room.roomId)).toContain(quick.room.roomId);
    expect(server.health()).toMatchObject({ rooms: 8, players: 9 });
    expect(stub.games).toHaveLength(8);

    await quick.leave();
    await players[0].leave();
    await waitFor(() => server.health().rooms === 7, 'a slot to free');
    const again = await TestPlayer.create(endpoint, 'stub', { name: 'again' }, HEADERS);
    expect(server.health().rooms).toBe(8);
    await Promise.all([...players.slice(1), again].map((p) => p.leave()));
  });
});
