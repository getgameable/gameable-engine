/**
 * A guest sets the room's phase with `ctx.net.setPhase`, on the production
 * room: the phase game (a real SDK guest, `net/src/server/room/phaseTesting.ts`)
 * in `GameableColyseusRoom` under `createRoomServer`. The phase reaches the lobby's
 * listing (`listRooms`), and no player ever receives the reserved
 * `aos:phase`; a player's own `aos:phase` changes nothing.
 */
import { createEngineRoomGame } from '@gameable/net/server';
import type { GameDefinition } from '@gameable/sdk';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { listRooms } from '../client/listRooms.js';
import { createRoomServer, type RoomServer } from './host/createRoomServer.js';
import { TestPlayer } from './testing/TestPlayer.js';
import { OPEN_LIMITS, waitFor } from './testing/testServer.js';

interface PhaseFixture {
  phaseGame(): GameDefinition;
}

const HEADERS = { origin: 'http://game.test' };
const ask = (word: string): string => JSON.stringify({ t: 'msg', name: 'phase', payload: word });

let server: RoomServer;
let endpoint: string;

beforeAll(async () => {
  const url = new URL('../../../net/src/server/room/phaseTesting.ts', import.meta.url);
  const fixture = (await import(url.href)) as PhaseFixture;
  server = createRoomServer({
    port: 0,
    origins: [HEADERS.origin],
    maxRooms: 1, // a direct guest: one room per process
    games: {
      phased: {
        maxPlayers: 2,
        direct: true,
        create: () =>
          createEngineRoomGame({ definition: fixture.phaseGame(), maxPlayers: 2, seed: 1 }),
      },
    },
    limits: OPEN_LIMITS,
  });
  endpoint = `ws://127.0.0.1:${String(await server.listen())}`;
});

afterAll(async () => {
  await server.close();
});

describe('GameableColyseusRoom over a real guest: ctx.net.setPhase', () => {
  it("reaches the room list's metadata, and no player receives aos:phase", async () => {
    const a = await TestPlayer.create(endpoint, 'phased', { name: 'a' }, HEADERS);
    const code = a.room.roomId;
    const b = await TestPlayer.joinById(endpoint, code, { name: 'b', game: 'phased' }, HEADERS);
    await waitFor(() => a.replica.welcomes === 1 && b.replica.welcomes === 1, 'two welcomes');

    const list = await listRooms('phased', { url: endpoint, headers: HEADERS });
    const row = () => list.rooms.find((r) => r.code === code);
    await waitFor(() => row() !== undefined, 'the room in the list');
    expect(row()?.phase).toBeNull();

    a.sendText(ask('voting'));
    await waitFor(() => row()?.phase === 'voting', 'the phase to reach the list');

    // A player cannot set it: their own aos:phase is dropped before the guest.
    b.sendText(JSON.stringify({ t: 'msg', name: 'aos:phase', payload: 'forged' }));
    a.sendText(ask('lobby'));
    await waitFor(() => row()?.phase === 'lobby', 'the next phase to reach the list');
    expect(row()?.phase).toBe('lobby');

    await waitFor(
      () => a.replica.messages.length === 2 && b.replica.messages.length === 2,
      'both controls',
    );
    for (const p of [a, b]) expect(p.replica.messages.map((m) => m.name)).toEqual(['all', 'all']);

    list.close();
    await Promise.all([a.leave(), b.leave()]);
  }, 30_000);
});
