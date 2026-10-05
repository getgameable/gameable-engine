/**
 * `advanceRoom`: a seat that stops sending input goes neutral after 250 ms
 * (phase 3 review, client I1, the server half): a hidden tab or a stalled
 * link does not keep its keys held in the game.
 */
import { describe, expect, it } from 'vitest';

import { advanceRoom, buildRoomParts } from './RoomParts.js';
import { stubEntry } from './testing/StubGame.js';

const STEP = 1000 / 60;

describe('advanceRoom: input goes neutral after 250 ms without a frame', () => {
  it('lets go of a held key once, then hands the game nothing more', async () => {
    const entry = stubEntry();
    const parts = await buildRoomParts(entry, new Map());
    const game = entry.games[0];
    const player = parts.seats.add('s-a', 'Ana', 0).player;
    player.pending.down[0] = 1; // a frame with a key held
    player.pending.focused = true;
    player.hasPending = true;
    let now = 0;
    advanceRoom(parts, (now += STEP));
    expect(game.inputs).toEqual([0]);
    for (let i = 0; i < 20; i += 1) advanceRoom(parts, (now += STEP)); // 333 ms, no frames
    expect(game.inputs).toEqual([0, 0]);
    expect(player.pending.down[0]).toBe(0);
    expect(player.pending.focused).toBe(false);
    for (let i = 0; i < 20; i += 1) advanceRoom(parts, (now += STEP));
    expect(game.inputs).toEqual([0, 0]);
    parts.game.dispose();
  });
});
