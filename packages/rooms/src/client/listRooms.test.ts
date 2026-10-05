/**
 * `listRooms` against a real `createRoomServer` on port 0: the public rooms
 * of one game, live. Private rooms and other games stay out; the counts and a
 * game's phase follow joins, leaves and `setPhase`; `close()` gives the lobby
 * socket back.
 */
import { Client } from '@colyseus/sdk';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createRoomServer, type RoomServer } from '../server/host/createRoomServer.js';
import { stubGame } from '../server/testing/StubGame.js';
import { TestPlayer } from '../server/testing/TestPlayer.js';
import { OPEN_LIMITS, waitFor } from '../server/testing/testServer.js';
import { listRooms } from './listRooms.js';

const HEADERS = { origin: 'http://game.test' };
const alpha = stubGame({ maxPlayers: 4 });

let server: RoomServer;
let endpoint: string;

beforeAll(async () => {
  server = createRoomServer({
    port: 0,
    origins: [HEADERS.origin],
    games: { alpha, beta: stubGame() },
    limits: OPEN_LIMITS,
  });
  endpoint = `ws://127.0.0.1:${String(await server.listen())}`;
});

afterAll(async () => {
  await server.close();
});

describe('listRooms', () => {
  it("lists one game's public rooms with live counts and phase, never a private room", async () => {
    const a = await TestPlayer.create(endpoint, 'alpha', { name: 'a' }, HEADERS);
    const b = await TestPlayer.create(endpoint, 'alpha', { name: 'b' }, HEADERS);
    const hidden = await TestPlayer.create(
      endpoint,
      'alpha',
      { name: 'p', private: true },
      HEADERS,
    );
    const other = await TestPlayer.create(endpoint, 'beta', { name: 'o' }, HEADERS);
    const codeA = a.room.roomId;
    const codeB = b.room.roomId;

    const list = await listRooms('alpha', { url: endpoint, headers: HEADERS });
    const row = (code: string) => list.rooms.find((r) => r.code === code);
    await waitFor(() => list.rooms.length === 2, 'the two public alpha rooms');
    expect(list.state).toBe('open');
    expect(list.rooms.map((r) => r.code).sort()).toEqual([codeA, codeB].sort());
    expect(row(codeA)).toEqual({ code: codeA, players: 1, maxPlayers: 4, phase: null });

    // The server's own filter, not the page's: the raw lobby never names the private room.
    const raw = await new Client(endpoint, { headers: { ...HEADERS } }).joinOrCreate('lobby', {
      filter: { name: 'alpha' },
    });
    const seen = new Set<string>();
    const note = (entry: unknown): void => {
      const id = (entry as { roomId?: unknown } | null)?.roomId;
      if (typeof id === 'string') seen.add(id);
    };
    raw.onMessage('rooms', (entries: unknown) => {
      for (const entry of Array.isArray(entries) ? entries : []) note(entry);
    });
    raw.onMessage('+', (pair: unknown) => {
      if (Array.isArray(pair)) note({ roomId: (pair as unknown[])[0] });
    });
    raw.onMessage('-', () => undefined);
    await waitFor(() => seen.has(codeA) && seen.has(codeB), 'the raw lobby list');
    expect(seen.has(hidden.room.roomId)).toBe(false);

    let changes = 0;
    const off = list.onChange(() => {
      changes += 1;
    });
    const friend = await TestPlayer.joinById(
      endpoint,
      codeA,
      { name: 'f', game: 'alpha' },
      HEADERS,
    );
    await waitFor(() => row(codeA)?.players === 2, 'the join to reach the list');
    expect(changes).toBeGreaterThan(0);

    alpha.games.find((g) => g.joins.some((j) => j.name === 'b'))?.phaseTo('playing');
    await waitFor(() => row(codeB)?.phase === 'playing', "b's phase to reach the list");

    await friend.leave();
    await waitFor(() => row(codeA)?.players === 1, 'the leave to reach the list');
    await b.leave();
    await waitFor(() => row(codeB) === undefined, 'the emptied room to leave the list');
    expect(list.rooms.some((r) => r.code === hidden.room.roomId)).toBe(false);
    expect(list.rooms.some((r) => r.code === other.room.roomId)).toBe(false);

    expect(seen.has(hidden.room.roomId)).toBe(false); // nor any update since
    await raw.leave();
    off();
    list.close();
    expect(list.state).toBe('closed');
    await Promise.all([a.leave(), hidden.leave(), other.leave()]);
  }, 20_000);

  it('rejects when the room server refuses the lobby (a bad origin)', async () => {
    const refused = listRooms('alpha', {
      url: endpoint,
      headers: { origin: 'https://evil.example' },
    });
    await expect(refused).rejects.toThrow();
  });
});
