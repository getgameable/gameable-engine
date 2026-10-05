/**
 * A direct-mode game (a `defineGame` result run in this JS realm, no wasm
 * guest) on the room server: allowed with `maxRooms: 1` only, because two
 * direct rooms in one process share the SDK's component arrays. Here the one
 * room is the real tiny game, built through `engineGame`, which also shows
 * that the server registers no input module.
 */
import type { EngineRoomGame } from '@gameable/net/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { CatalogGame } from './RoomCatalog.js';
import { TestPlayer } from '../testing/TestPlayer.js';
import { localRoom, tinyEngineGame, waitFor } from '../testing/testServer.js';
import { createRoomServer, type RoomServer } from './createRoomServer.js';

const HEADERS = { origin: 'http://game.test' };
let tiny: CatalogGame;
let server: RoomServer;
let endpoint: string;

beforeAll(async () => {
  tiny = await tinyEngineGame();
  server = createRoomServer({ port: 0, origins: [HEADERS.origin], games: { tiny }, maxRooms: 1 });
  endpoint = `ws://127.0.0.1:${String(await server.listen())}`;
});

afterAll(async () => {
  await server.close();
});

describe('createRoomServer: a direct-mode game', () => {
  it('refuses a direct game with maxRooms above 1, and names the wasm guest as the way', () => {
    expect(tiny.direct).toBe(true);
    for (const maxRooms of [undefined, 2, 8])
      expect(() =>
        createRoomServer({ port: 0, origins: [HEADERS.origin], games: { tiny }, maxRooms }),
      ).toThrow(/tiny run in direct mode.*wasm guest.*maxRooms: 1/);
  });

  it('runs one direct room with physics and the slot only: no input module on the server', async () => {
    const a = await TestPlayer.create(endpoint, 'tiny', { name: 'A' }, HEADERS);
    await waitFor(() => a.replica.welcomes === 1, 'the welcome');
    const game = localRoom(a.room.roomId).game as EngineRoomGame;
    expect(game.maxPlayers).toBe(2); // roomSeats(definition), passed through the catalog
    expect(game.engine.modules.modules.map((m) => m.id).sort()).toEqual(['game', 'physics']);
    await a.leave();
  });
});
