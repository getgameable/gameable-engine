/**
 * Task 5.2 on the Colyseus room: a game built by `engineGame` with a store
 * loads a player's document by their identity, and the document their guest
 * saved is there when the same device comes back.
 */
import { createIdentities, deviceIdentity, memoryStore } from '@gameable/net/server';
import { defineGame } from '@gameable/sdk';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { TestPlayer } from '../testing/TestPlayer.js';
import { localRoom, waitFor } from '../testing/testServer.js';
import { createRoomServer, type RoomServer } from './createRoomServer.js';
import { engineGame } from './engineGame.js';

const HEADERS = { origin: 'http://game.test' };
const SECRET = 'a-test-secret-that-is-32-bytes-ok';
const store = memoryStore();
/** What each join handed the guest, in order. */
const seen: unknown[] = [];

/** Counts a player's visits in their document. */
const visits = defineGame({
  features: { multiplayer: { maxPlayers: 2 } },
  update: (ctx) => {
    for (const event of ctx.events) {
      if (event.tag !== 'player-joined') continue;
      const doc = ctx.players.get(event.val.player)?.data as { visits?: number } | null;
      seen.push(doc);
      ctx.data.save(event.val.player, { visits: (doc?.visits ?? 0) + 1 });
    }
  },
});

let server: RoomServer;
let endpoint: string;

beforeAll(async () => {
  const game = engineGame({
    definition: visits,
    manifest: { version: 1, assets: [] },
    data: { store, game: 'visits' },
  });
  server = createRoomServer({
    port: 0,
    origins: [HEADERS.origin],
    games: { visits: game },
    maxRooms: 1,
    identities: createIdentities({ device: deviceIdentity(SECRET) }),
  });
  endpoint = `ws://127.0.0.1:${String(await server.listen())}`;
});

afterAll(async () => {
  await server.close();
});

describe('createRoomServer: player data', () => {
  it('a device that comes back sees the document its last visit saved', async () => {
    const first = await TestPlayer.create(endpoint, 'visits', { name: 'Gus' }, HEADERS);
    await waitFor(() => first.identityTokens.length > 0, 'the device token');
    const token = first.identityTokens[0];
    const id = localRoom(first.room.roomId).seats.get(first.room.sessionId)?.identity?.id ?? '';
    await waitFor(() => seen.length === 1, 'the first join in the guest');
    await first.leave(); // the room closes with its last player, and flushes
    let saved: string | undefined;
    for (let i = 0; i < 100 && saved === undefined; i += 1) {
      saved = (await store.load('visits', id))?.data;
      if (saved === undefined) await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(JSON.parse(saved ?? 'null')).toEqual({ visits: 1 });

    const again = await TestPlayer.create(
      endpoint,
      'visits',
      { name: 'Gus', device: token },
      HEADERS,
    );
    await waitFor(() => seen.length === 2, 'the second join in the guest');
    expect(seen).toEqual([null, { visits: 1 }]);
    await again.leave();
  });
});
