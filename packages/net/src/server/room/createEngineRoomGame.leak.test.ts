/**
 * A build that fails half-way must release its engine and Jolt world (3.8
 * review I3): Jolt aborts after about ten live worlds in one process, so a
 * client asking for rooms of a broken game would otherwise leave a server that
 * cannot build any room at all.
 */
import { defineGame } from '@gameable/sdk';
import { describe, expect, it } from 'vitest';

import { createEngineRoomGame } from './createEngineRoomGame.js';

/** A wasm guest whose module throws as it loads, before any guest code runs. */
const brokenGuest = {
  guestModuleUrl: `data:text/javascript,${encodeURIComponent('throw new Error("guest load failed");')}`,
  getCoreModule: (): Promise<WebAssembly.Module> => Promise.reject(new Error('no core modules')),
};

describe('createEngineRoomGame when loading the guest throws', () => {
  it('disposes the engine every time: 12 failed builds, then a good game still builds', async () => {
    for (let i = 0; i < 12; i += 1)
      await expect(createEngineRoomGame({ guest: brokenGuest, maxPlayers: 2 })).rejects.toThrow(
        /guest load failed/,
      );
    const game = await createEngineRoomGame({ definition: defineGame({}), maxPlayers: 2, seed: 7 });
    expect(game.engine.modules.modules.map((m) => m.id).sort()).toEqual(['game', 'physics']);
    game.dispose();
    await game.disposed;
  }, 120_000);
});
