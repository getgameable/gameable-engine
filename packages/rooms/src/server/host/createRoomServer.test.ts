/**
 * `createRoomServer` end to end: a real server on port 0, `@colyseus/sdk`
 * players, the stub game. Origins, codes, the lobby listing and `/health`.
 * The room cap, crash isolation, limits, guessing and the direct-mode game
 * have files of their own: the matchmaker is one per process, so each needs a
 * server of its own.
 */
import { matchMaker } from '@colyseus/core';
import { Client } from '@colyseus/sdk';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { getHealth, postStatus, upgradeStatus } from '../testing/httpProbe.js';
import { stubGame } from '../testing/StubGame.js';
import { TestPlayer } from '../testing/TestPlayer.js';
import { OPEN_LIMITS, waitFor } from '../testing/testServer.js';
import { createRoomServer, type RoomServer } from './createRoomServer.js';

const ORIGIN = 'http://game.test';
const HEADERS = { origin: ORIGIN };
const EVIL = 'https://evil.example';

let server: RoomServer;
let port: number;
let endpoint: string;

beforeAll(async () => {
  server = createRoomServer({
    port: 0,
    origins: [ORIGIN],
    games: { stub: stubGame() },
    limits: OPEN_LIMITS,
  });
  port = await server.listen();
  endpoint = `ws://127.0.0.1:${String(port)}`;
});

afterAll(async () => {
  await server.close();
});

describe('createRoomServer', () => {
  it('listens on the port it resolves to, and /health is the same JSON as health(), with the catalog', async () => {
    expect(port).toBeGreaterThan(0);
    const { status, body } = await getHealth(port);
    expect(status).toBe(200);
    expect(body).toMatchObject({ ok: true, rooms: 0, players: 0, games: ['stub'] });
    expect(typeof (body as { uptime: unknown }).uptime).toBe('number');
    expect(server.health()).toMatchObject({ ok: true, rooms: 0, players: 0 });
  });

  it('answers a bad Origin 403 before any room is touched: matchmaking and upgrade', async () => {
    const before = server.health().rooms;
    for (const method of ['create', 'joinOrCreate', 'join'])
      expect(await postStatus(port, `/matchmake/${method}/stub`, EVIL)).toBe(403);
    expect(await postStatus(port, '/matchmake/create/stub')).toBe(403); // no Origin at all
    expect(await postStatus(port, '/matchmake/joinOrCreate/lobby', EVIL)).toBe(403);
    expect(await upgradeStatus(port, '/p/ABCD?sessionId=x', EVIL)).toBe(403);
    expect(await upgradeStatus(port, '/p/ABCD?sessionId=x')).toBe(403);
    expect(server.health().rooms).toBe(before);
    // The control: the good origin gets through both doors.
    expect(await upgradeStatus(port, '/p/ABCD?sessionId=x', ORIGIN)).toBe(101);
    const a = await TestPlayer.create(endpoint, 'stub', { name: 'A' }, HEADERS);
    expect(server.health().rooms).toBe(before + 1);
    await a.leave();
    await waitFor(() => server.health().rooms === before, 'the room to go');
  });

  it('gives each room a four-letter code: its id, in its metadata, and joinable both ways', async () => {
    const a = await TestPlayer.create(endpoint, 'stub', { name: 'A' }, HEADERS);
    const code = a.room.roomId;
    expect(code).toMatch(/^[ABCDEFGHJKMNPQRSTUVWXYZ]{4}$/);
    const [listed] = await matchMaker.query({ roomId: code });
    expect(listed.metadata).toMatchObject({ code }); // A's join re-set the metadata and kept the code
    const b = await TestPlayer.join(endpoint, 'stub', { name: 'B', code }, HEADERS);
    expect(b.room.roomId).toBe(code);
    await waitFor(() => b.replica.welcomes === 1, "B's welcome");

    const other = await TestPlayer.create(endpoint, 'stub', { name: 'C' }, HEADERS);
    expect(other.room.roomId).not.toBe(code); // "new" is a fresh code
    const d = await TestPlayer.joinById(endpoint, other.room.roomId, { name: 'D', game: other.room.name }, HEADERS);
    expect(d.room.roomId).toBe(other.room.roomId);
    await Promise.all([a.leave(), b.leave(), other.leave(), d.leave()]);
  });

  it('refuses a code no live room has, and never creates a room for it', async () => {
    const before = server.health().rooms;
    const join = TestPlayer.join(endpoint, 'stub', { code: 'ZZZZ' }, HEADERS);
    await expect(join).rejects.toThrow(/no rooms found|ZZZZ/);
    const orCreate = TestPlayer.joinOrCreate(endpoint, 'stub', { code: 'ZZZZ' }, HEADERS);
    await expect(orCreate).rejects.toThrow(/no room has the code "ZZZZ"/);
    expect(server.health().rooms).toBe(before);
  });

  it('lists public rooms in the lobby with their metadata and keeps private ones out', async () => {
    const pub = await TestPlayer.create(endpoint, 'stub', { name: 'pub' }, HEADERS);
    const priv = await TestPlayer.create(endpoint, 'stub', { name: 'priv', private: true }, HEADERS);
    const lobby = await new Client(endpoint, { headers: HEADERS }).joinOrCreate('lobby');
    lobby.onMessage('+', () => {});
    lobby.onMessage('-', () => {});
    const rooms = await new Promise<{ roomId: string; metadata: unknown }[]>((resolve) => {
      lobby.onMessage('rooms', resolve);
    });
    const ids = rooms.map((r) => r.roomId);
    expect(ids).toContain(pub.room.roomId);
    expect(ids).not.toContain(priv.room.roomId);
    expect(rooms.find((r) => r.roomId === pub.room.roomId)?.metadata).toEqual({
      game: 'stub',
      code: pub.room.roomId,
      players: 1,
      maxPlayers: 2,
    });
    // Private is unlisted, not unreachable: its code still lets a friend in.
    const friend = await TestPlayer.joinById(endpoint, priv.room.roomId, { name: 'f', game: priv.room.name }, HEADERS);
    await waitFor(() => friend.replica.welcomes === 1, 'the private room is joinable by its code');
    await Promise.all([pub.leave(), priv.leave(), friend.leave(), lobby.leave()]);
  });

  it('counts rooms and players, held seats included, in health() and /health', async () => {
    await waitFor(() => server.health().rooms === 0, 'earlier rooms to go');
    const a = await TestPlayer.create(endpoint, 'stub', { name: 'A' }, HEADERS);
    const b = await TestPlayer.joinById(endpoint, a.room.roomId, { name: 'B', game: a.room.name }, HEADERS);
    const c = await TestPlayer.create(endpoint, 'stub', { name: 'C' }, HEADERS);
    await waitFor(() => server.health().players === 3, 'three seats');
    expect(server.health()).toMatchObject({ ok: true, rooms: 2, players: 3 });
    expect((await getHealth(port)).body).toMatchObject({ ok: true, rooms: 2, players: 3 });
    await Promise.all([a.leave(), b.leave(), c.leave()]);
    await waitFor(() => server.health().rooms === 0, 'the rooms to go');
    expect(server.health().players).toBe(0);
  });
});
