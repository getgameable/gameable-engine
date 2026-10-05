/**
 * Room codes against a guesser (3.8 review I1): without a good Origin every
 * matchmaking call gets the same 403, so probes cannot tell a live code from
 * a dead one; with one, failed lookups are limited per address (10, then 1
 * per 2 s) and the 11th quick wrong guess gets 429. Forged forwarding headers
 * do not buy more guesses.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { post, upgradeStatus } from '../testing/httpProbe.js';
import { hasIpv6Loopback } from '../testing/ipv6.js';
import { stubGame } from '../testing/StubGame.js';
import { TestPlayer } from '../testing/TestPlayer.js';
import { waitFor } from '../testing/testServer.js';
import { createRoomServer, type RoomServer } from './createRoomServer.js';

const ORIGIN = 'http://game.test';
/** `::1` is the second client address below; a host without an IPv6 loopback skips those cases (M2). */
const ipv6 = await hasIpv6Loopback('createRoomServer.codes.test');
let server: RoomServer;
let port: number;
let live: TestPlayer;

beforeAll(async () => {
  // The WebSocket test below has its own address budget: it runs from ::1, the HTTP ones from 127.0.0.1.
  const host = ipv6 ? '::' : '127.0.0.1';
  server = createRoomServer({ port: 0, host, origins: [ORIGIN], games: { stub: stubGame() } });
  port = await server.listen();
  const endpoint = `ws://127.0.0.1:${String(port)}`;
  live = await TestPlayer.create(endpoint, 'stub', { name: 'host', private: true }, { origin: ORIGIN });
});

afterAll(async () => {
  await live.leave();
  await server.close();
});

describe('createRoomServer: codes against a guesser', () => {
  it('answers a probe with no or a bad Origin the same way for a live code and a dead one', async () => {
    const code = live.room.roomId;
    const dead = code === 'QQQQ' ? 'WWWW' : 'QQQQ';
    const probes = [
      ['joinById', code, {}],
      ['joinById', dead, {}],
      ['reconnect', code, { reconnectionToken: 'x' }],
      ['reconnect', dead, { reconnectionToken: 'x' }],
      ['join', 'stub', { code }],
      ['join', 'stub', { code: dead }],
    ] as const;
    for (const origin of [undefined, 'https://evil.example']) {
      const answers: { status: number; body: string }[] = [];
      for (const [method, room, body] of probes)
        answers.push(await post(port, `/matchmake/${method}/${room}`, { origin, body }));
      expect(new Set(answers.map((a) => `${String(a.status)} ${a.body}`)).size).toBe(1);
      expect(answers[0].status).toBe(403);
    }
  });

  it('gives the 11th quick wrong guess from one address 429, forged forwarding headers or not', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 11; i += 1) {
      const guess = `/matchmake/joinById/${'ABCDEFGHJKM'[i]}ZZZ`;
      const ip = `198.51.100.${String(i)}`;
      const forged = { 'x-forwarded-for': ip, 'x-real-ip': ip };
      statuses.push((await post(port, guess, { origin: ORIGIN, headers: forged })).status);
    }
    expect(statuses.slice(0, 10).every((s) => s !== 429)).toBe(true);
    expect(statuses[10]).toBe(429);
    // Out of guesses, even the live code is refused before the lookup.
    const right = await post(port, `/matchmake/joinById/${live.room.roomId}`, { origin: ORIGIN });
    expect(right.status).toBe(429);
  });

  it.skipIf(!ipv6)('charges failed lookups on the WebSocket upgrade to the same bucket, then refuses the upgrade 429', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 11; i += 1) {
      const path = `/p/${'ABCDEFGHJKM'[i]}YYY?sessionId=nobody${String(i)}`; // no such room or seat
      statuses.push(await upgradeStatus(port, path, ORIGIN, '::1'));
    }
    expect(statuses.slice(0, 10).every((s) => s !== 429)).toBe(true);
    expect(statuses[10]).toBe(429);
    // One bucket for both doors: the HTTP route from that address is out of guesses too.
    const http = await post(port, '/matchmake/joinById/ZZZZ', { origin: ORIGIN, host: '::1' });
    expect(http.status).toBe(429);
  });

  it.skipIf(!ipv6)('does not let a Host header hide the room path from the upgrade check (M1)', async () => {
    // ::1 is out of guesses (the test above). Request.url is built from Host; the check reads the raw path.
    for (const host of ['localhost#', 'localhost?x=', 'localhost/']) {
      const status = await upgradeStatus(port, '/p/QQQQ?sessionId=x', ORIGIN, '::1', { host });
      expect(status).toBe(429);
    }
  });

  it.skipIf(!ipv6)('still lets an address that is out of guesses connect to a seat it reserved (I3)', async () => {
    // ::1 is out of guesses; a create is not a lookup, and the upgrade to its reserved seat passes.
    const player = await TestPlayer.create(`ws://[::1]:${String(port)}`, 'stub', { name: 'P' }, { origin: ORIGIN });
    await waitFor(() => player.replica.welcomes === 1, 'the welcome despite the empty bucket');
    await player.leave();
  });
});
