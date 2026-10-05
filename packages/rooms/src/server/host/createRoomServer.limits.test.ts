/**
 * Holding the cap from outside (3.8 review I2): creates are limited per
 * address (4 a minute), a create nobody connects to frees its room and slot
 * in about 5 s, and the lobby is one room, not one per request.
 */
import { Client } from '@colyseus/sdk';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { post } from '../testing/httpProbe.js';
import { stubGame } from '../testing/StubGame.js';
import { waitFor } from '../testing/testServer.js';
import { createRoomServer, type RoomServer } from './createRoomServer.js';

const ORIGIN = 'http://game.test';
let server: RoomServer;
let port: number;
const handlers = (): number[] => [
  process.listenerCount('unhandledRejection'),
  process.listenerCount('uncaughtException'),
];
let baseline: number[];

beforeAll(async () => {
  baseline = handlers();
  server = createRoomServer({ port: 0, origins: [ORIGIN], games: { stub: stubGame() } });
  port = await server.listen();
});

afterAll(async () => {
  await server.close(); // already closed by the last test
});

describe('createRoomServer: limits on making rooms', () => {
  it('installs a log-and-keep-running handler for unhandled rejections and uncaught exceptions', () => {
    expect(handlers()).toEqual(baseline.map((n) => n + 1));
  });

  it('stops a script holding the cap: 2 live rooms per address, 4 creates a minute, slots back in ~5 s', async () => {
    const create = (): Promise<{ status: number; body: string }> =>
      post(port, '/matchmake/create/stub', { origin: ORIGIN });
    const first = await Promise.all([1, 2, 3, 4, 5, 6, 7, 8].map(() => create()));
    expect(first.map((r) => r.status).sort()).toEqual([200, 200, 429, 429, 429, 429, 429, 429]);
    expect(first.filter((r) => r.status === 429)[0].body).toMatch(/holds 2 live rooms/); // M3
    expect(server.health().rooms).toBe(2); // never the cap of 8
    const before = performance.now();
    await waitFor(() => server.health().rooms === 0, 'the unclaimed rooms to go', 9000);
    expect((performance.now() - before) / 1000).toBeLessThan(7); // 5 s, not Colyseus's 15
    // The live rooms are back, but the rate is not: two more creates spend tokens 3 and 4.
    expect([(await create()).status, (await create()).status]).toEqual([200, 200]);
    await waitFor(() => server.health().rooms === 0, 'those to go too', 9000);
    const fifth = await create();
    expect(fifth.status).toBe(429);
    expect(fifth.body).toMatch(/too many rooms created/);
  }, 30_000);

  it('keeps one lobby: a second create is refused and joinOrCreate joins the one there is', async () => {
    const client = new Client(`ws://127.0.0.1:${String(port)}`, { headers: { origin: ORIGIN } });
    const first = await client.create('lobby');
    await expect(client.create('lobby')).rejects.toThrow(/lobby already exists/);
    const joined = await client.joinOrCreate('lobby');
    expect(joined.roomId).toBe(first.roomId);
    await Promise.all([first.leave(), joined.leave()]);
  });

  it('holds at most 4 lobby sockets per address, and frees one when it closes (M4)', async () => {
    const client = new Client(`ws://127.0.0.1:${String(port)}`, { headers: { origin: ORIGIN } });
    const sockets = [];
    for (let i = 0; i < 4; i += 1) sockets.push(await client.joinOrCreate('lobby'));
    await expect(client.joinOrCreate('lobby')).rejects.toThrow(/most lobby sockets/);
    await sockets[0].leave();
    await new Promise((resolve) => setTimeout(resolve, 100)); // the server sees the leave
    const again = await client.joinOrCreate('lobby');
    await Promise.all([...sockets.slice(1), again].map((room) => room.leave()));
  });

  it('closes: health says not ok, and the process handlers are gone', async () => {
    await server.close();
    expect(server.health().ok).toBe(false); // the HEALTHCHECK must fail
    expect(handlers()).toEqual(baseline);
  });
});
