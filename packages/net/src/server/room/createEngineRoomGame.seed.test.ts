/**
 * One seed per room (the ledger's seed gap, ruled in 3.11a): `ctx.rng` is
 * seeded from the host's `seed()`, `ctx.config.seed` is the game config's, and
 * `createEngineRoomGame` hands its one `seed` to both, so the two can never
 * disagree. The host's wins by construction: there is no second value.
 */
import { defineGame, type GameContext } from '@gameable/sdk';
import { afterEach, describe, expect, it } from 'vitest';

import { createEngineRoomGame } from './createEngineRoomGame.js';
import type { EngineRoomGame } from './EngineRoomGame.js';

/** What the guest's `init` read. */
const seen = { config: -1, draws: [] as number[] };

const game0 = defineGame({
  init: (ctx: GameContext) => {
    seen.config = Number(ctx.config.seed);
    seen.draws = [ctx.rng.int(1_000_000), ctx.rng.int(1_000_000), ctx.rng.int(1_000_000)];
  },
});

let game: EngineRoomGame | null = null;

afterEach(async () => {
  game?.dispose();
  await game?.disposed;
  game = null;
});

/**
 * @param seed The room's seed.
 * @returns What its guest saw at init.
 */
async function room(seed: number): Promise<{ config: number; draws: number[] }> {
  game = await createEngineRoomGame({ definition: game0, maxPlayers: 1, seed });
  const out = { config: seen.config, draws: [...seen.draws] };
  game.dispose();
  await game.disposed;
  game = null;
  return out;
}

describe('createEngineRoomGame: the seed', () => {
  it('reaches the game config and the rng as one value', async () => {
    const a = await room(99);
    expect(a.config).toBe(99);
    const again = await room(99);
    expect(again.draws).toEqual(a.draws); // same seed, same rolls
    const b = await room(100);
    expect(b.config).toBe(100);
    expect(b.draws).not.toEqual(a.draws); // the rng follows the seed, not a constant
  }, 60_000);
});
