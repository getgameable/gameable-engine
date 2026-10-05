/**
 * The host role over a real guest: a held seat is out of the guest's players
 * list, so `ctx.players.host` passes off a host who dropped, and stays with
 * the new host when they come back (sticky until they leave).
 */
import { defineGame } from '@gameable/sdk';
import { describe, expect, it } from 'vitest';

import { createEngineRoomGame } from './createEngineRoomGame.js';

const MANIFEST = { version: 1, assets: [] };
const MS = 1000 / 60;

describe('EngineRoomGame: the host during a hold', () => {
  it('moves the host off a held seat, and does not move it back on resume', async () => {
    let host: number | undefined = -1;
    const definition = defineGame({
      features: { multiplayer: { maxPlayers: 4 } },
      update: (ctx) => {
        host = ctx.players.host;
      },
    });
    const game = await createEngineRoomGame({ definition, manifest: MANIFEST, seed: 7 });
    let t = 0;
    const tick = (): void => {
      for (let i = 0; i < 3; i += 1) {
        t += 1;
        game.tick(t * MS);
      }
    };
    game.join(0, 'Ana', null);
    game.join(1, 'Ben', null);
    tick();
    expect(host).toBe(0);

    game.hold(0);
    tick();
    expect(host).toBe(1);

    game.resume(0);
    tick();
    expect(host).toBe(1);

    game.leave(1, 'left');
    tick();
    expect(host).toBe(0);
    game.dispose();
    await game.disposed;
  }, 60_000);
});
