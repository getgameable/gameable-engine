/**
 * Seats against a script (phase 3 review): one address holds at most 4 live
 * seats across every room (I3); a code from another game in the same process
 * is a wrong code (I5); and a reconnect with a valid token passes even when
 * its address and the whole process are out of failed lookups (I4).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { post } from '../testing/httpProbe.js';
import { stubGame } from '../testing/StubGame.js';
import { TestPlayer } from '../testing/TestPlayer.js';
import { killSocket, waitFor } from '../testing/testServer.js';
import { createRoomServer, type RoomServer } from './createRoomServer.js';

const ORIGIN = 'http://game.test';
let server: RoomServer;
let port: number;
let endpoint: string;

/**
 * @param ip The client address, as the one trusted proxy in front saw it.
 * @returns Headers for a player at that address.
 */
const from = (ip: string): Record<string, string> => ({ origin: ORIGIN, 'x-forwarded-for': ip });

beforeAll(async () => {
  server = createRoomServer({
    port: 0,
    origins: [ORIGIN],
    games: { alpha: stubGame({ maxPlayers: 8 }), beta: stubGame({ maxPlayers: 8 }) },
    trustProxy: 1,
    limits: { misses: { burst: 2, refillMs: 60_000 }, globalMisses: { burst: 4, refillMs: 60_000 } },
  });
  port = await server.listen();
  endpoint = `ws://127.0.0.1:${String(port)}`;
});

afterAll(async () => {
  await server.close();
});

describe('createRoomServer: seats per address', () => {
  it('seats at most 4 players from one address across rooms, and frees one when it leaves (I3)', async () => {
    const one = from('203.0.113.1');
    const host = await TestPlayer.create(endpoint, 'alpha', { name: 'H' }, one);
    const code = host.room.roomId;
    const join = (headers: Record<string, string>): Promise<TestPlayer> =>
      TestPlayer.joinById(endpoint, code, { name: 'J', game: 'alpha' }, headers);
    const seats = [host, await join(one), await join(one)];
    seats.push(await TestPlayer.create(endpoint, 'beta', { name: 'B' }, one)); // the 4th, in another room
    await expect(join(one)).rejects.toMatchObject({ code: 429 });
    const other = await join(from('198.51.100.2')); // another address is not affected
    await seats[1].leave();
    await waitFor(() => server.health().players === 4, 'the leave to land');
    seats[1] = await join(one);
    await Promise.all([...seats, other].map((p) => p.leave()));
  });
});

describe('createRoomServer: a code from another game (I5)', () => {
  it('answers it as a wrong code: no seat in the other game, and a miss charged', async () => {
    const host = await TestPlayer.create(endpoint, 'alpha', { name: 'H' }, from('203.0.113.9'));
    const guesser = from('203.0.113.10');
    const cross = TestPlayer.joinById(endpoint, host.room.roomId, { name: 'X', game: 'beta' }, guesser);
    await expect(cross).rejects.toMatchObject({ code: 522 });
    expect(server.health().players).toBe(1);
    await expect(
      TestPlayer.joinById(endpoint, host.room.roomId, { name: 'Y', game: 'beta' }, guesser),
    ).rejects.toMatchObject({ code: 522 });
    // Two misses spent this address's budget of 2: even the right game is refused now.
    await expect(
      TestPlayer.joinById(endpoint, host.room.roomId, { name: 'Z', game: 'alpha' }, guesser),
    ).rejects.toMatchObject({ code: 429 });
    await host.leave();
  });
});

describe('createRoomServer: a reconnect with a valid token (I4)', () => {
  it('passes when its address and the process are out of failed lookups', async () => {
    const at = from('203.0.113.20');
    const player = await TestPlayer.create(endpoint, 'alpha', { name: 'P' }, at);
    await waitFor(() => player.replica.welcomes === 1, 'the welcome');
    const token = player.room.reconnectionToken;
    const roomId = player.room.roomId;
    for (let i = 0; i < 4; i += 1)
      await post(port, `/matchmake/joinById/QQQ${String(i)}`, { origin: ORIGIN, headers: at });
    const guess = await post(port, '/matchmake/joinById/QQQQ', { origin: ORIGIN, headers: at });
    expect(guess.status).toBe(429); // the address and the process are out of guesses
    killSocket(roomId, player.room.sessionId);
    await waitFor(() => player.leftWith !== null, 'the drop');
    await player.reconnect(token);
    await waitFor(() => player.replica.welcomes === 2, 'the welcome after the reconnect');
    // A wrong token is still a guess, and still refused.
    const wrong = await post(port, `/matchmake/reconnect/${roomId}`, {
      origin: ORIGIN,
      headers: at,
      body: { reconnectionToken: 'not-a-token' },
    });
    expect(wrong.status).toBe(429);
    await player.leave();
  });
});
