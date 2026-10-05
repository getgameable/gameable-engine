/**
 * Task 4.2, end to end on the production room: the filters game (a real SDK
 * guest, `net/src/server/room/filtersTesting.ts`) in `GameableColyseusRoom` on a
 * real Colyseus server, three `@colyseus/sdk` players reading only their own
 * frames. A `send` with `to: 2` reaches player 2 only; a spawn inside
 * `ctx.net.local` reaches nobody; player 1's HUD reaches player 1 and never
 * player 2, in a view or in the welcome.
 */
import { createEngineRoomGame, type EngineRoomGame } from '@gameable/net/server';
import type { GameDefinition } from '@gameable/sdk';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { GameableRoomEntry } from './GameableRoomEntry.js';
import { TestPlayer } from './testing/TestPlayer.js';
import { localRoom, startTestServer, type TestServer, waitFor } from './testing/testServer.js';

interface FiltersFixture {
  filtersGame(): GameDefinition;
  MARKER: string;
  HUD_ONE: string;
}

const POKE = '{"t":"msg","name":"poke","payload":{}}';
let server: TestServer;
let fixture: FiltersFixture;

beforeAll(async () => {
  const url = new URL('../../../net/src/server/room/filtersTesting.ts', import.meta.url);
  fixture = (await import(url.href)) as FiltersFixture;
  const entry: GameableRoomEntry = {
    maxPlayers: 3,
    sendHz: 20,
    create: () =>
      createEngineRoomGame({ definition: fixture.filtersGame(), maxPlayers: 3, seed: 1 }),
  };
  server = await startTestServer({ filters: entry });
});

afterAll(async () => {
  await server.close();
});

/**
 * @param p A player.
 * @returns Each message it received, as `name n`.
 */
const messages = (p: TestPlayer): string[] =>
  p.replica.messages.map((m) => `${m.name} ${String((m.payload as { n: number }).n)}`);
const huds = (p: TestPlayer): unknown[] =>
  p.replica.commands.filter((c) => c.tag === 'set-player-hud');
const sawMarker = (p: TestPlayer): boolean =>
  p.replica.commands.some((c) => c.tag === 'spawn' && c.val.name === fixture.MARKER) ||
  [...p.replica.names.values()].includes(fixture.MARKER);

describe('GameableColyseusRoom over a real guest: the local and to filters end to end', () => {
  it('to: 2 reaches 2 only, a local spawn reaches nobody, 1’s HUD reaches only 1', async () => {
    const p0 = await TestPlayer.create(server.endpoint, 'filters', { name: 'Ana' });
    const roomId = p0.room.roomId;
    const p1 = await TestPlayer.joinById(server.endpoint, roomId, { name: 'Ben', game: 'filters' });
    await waitFor(() => p0.replica.welcomes === 1 && p1.replica.welcomes === 1, 'two welcomes');
    expect([p0.replica.player, p1.replica.player]).toEqual([0, 1]);

    p0.sendText(POKE); // player 2 is not here yet: its message goes nowhere
    await waitFor(() => huds(p1).length === 1 && messages(p0).length === 1, 'the first poke');

    const p2 = await TestPlayer.joinById(server.endpoint, roomId, { name: 'Cid', game: 'filters' });
    await waitFor(() => p2.replica.welcomes === 1, 'the late welcome');
    expect(p2.replica.player).toBe(2);
    expect((p2.replica.snapshot as { hud?: string }).hud).toBeUndefined(); // 1's HUD was set before 2 came
    p0.sendText(POKE);
    await waitFor(() => messages(p2).length === 2 && messages(p1).length === 2, 'the second poke');

    // The guest did emit it all: two markers in the authority's own world.
    const game = localRoom(roomId).game as EngineRoomGame;
    expect(
      [...game.adapter.world.entities.values()].filter((e) => e.name === fixture.MARKER),
    ).toHaveLength(2);

    expect(messages(p0)).toEqual(['all 1', 'all 2']);
    expect(messages(p1)).toEqual(['all 1', 'all 2']);
    expect(messages(p2)).toEqual(['for-two 2', 'all 2']);
    for (const p of [p0, p1, p2]) expect(sawMarker(p)).toBe(false);
    expect(huds(p1)).toEqual([{ tag: 'set-player-hud', val: { player: 1, hud: fixture.HUD_ONE } }]);
    expect(huds(p0)).toEqual([]);
    expect(huds(p2)).toEqual([]);
    await Promise.all([p0.leave(), p1.leave(), p2.leave()]);
  }, 60_000);
});
