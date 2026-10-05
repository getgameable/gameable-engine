/**
 * Body ids on a real room game (3.8 fix round 2): the SDK reuses freed ids, so
 * a game that fires 10,000 projectiles with at most 50 alive keeps every one
 * of them a body on the server under a small `maxBodies`; a game that really
 * holds more live bodies than `maxBodies` still gets the host's warn-once drop.
 * One direct room at a time: two direct runtimes must not share a realm.
 */
import { defineGame, type GameContext, prefab } from '@gameable/sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createEngineRoomGame } from './createEngineRoomGame.js';
import type { EngineRoomGame } from './EngineRoomGame.js';

const MS = 1000 / 60;
const MAX_BODIES = 128;
const Shot = prefab({ name: 'shot', body: { shape: 'sphere', kind: 'dynamic', dims: [0.1] } });

/**
 * @param perTick Projectiles fired each tick.
 * @param keep The most alive at once; the oldest-ish goes first, out of order.
 * @returns A game that fires and retires projectiles every tick.
 */
function gunGame(perTick: number, keep: number): { definition: ReturnType<typeof defineGame>; fired: { n: number } } {
  const alive: number[] = [];
  const fired = { n: 0 };
  const definition = defineGame({
    world: { gravity: 0, maxEntities: 4096 },
    init: () => {
      alive.length = 0;
    },
    systems: [
      (ctx: GameContext) => {
        for (let i = 0; i < perTick; i += 1) {
          if (alive.length >= keep) {
            const at = (ctx.frame * 7 + i * 13) % alive.length;
            ctx.despawn(alive[at]);
            alive[at] = alive[alive.length - 1];
            alive.pop();
          }
          alive.push(ctx.spawn(Shot, { x: i, y: 10, z: 0 }));
          fired.n += 1;
        }
      },
    ],
  });
  return { definition, fired };
}

/**
 * @param game The room game.
 * @returns The bodies Jolt was asked to add, counted from now on.
 */
function countAdds(game: EngineRoomGame): { ids: number[] } {
  const counter = { ids: [] as number[] };
  const world = game.engine.modules.get('physics') as { addBody(body: { id: number }): void };
  const addBody = world.addBody.bind(world);
  world.addBody = (body: { id: number }) => {
    counter.ids.push(body.id);
    addBody(body);
  };
  return counter;
}

let game: EngineRoomGame | null = null;

afterEach(async () => {
  game?.dispose();
  await game?.disposed;
  game = null;
  vi.restoreAllMocks();
});

describe('createEngineRoomGame: body ids', () => {
  it('gives every one of 10,000 projectiles a body, with at most 50 alive', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const gun = gunGame(50, 50);
    game = await createEngineRoomGame({
      definition: gun.definition,
      maxPlayers: 1,
      seed: 7,
      physicsOptions: { gravity: [0, 0, 0], maxBodies: MAX_BODIES },
    });
    const counter = countAdds(game);
    const before = gun.fired.n;
    for (let i = 0; gun.fired.n < 10_000; i += 1) game.tick(i * MS);
    expect(gun.fired.n).toBe(10_000);
    expect(counter.ids).toHaveLength(10_000 - before); // every projectile fired since is a Jolt body
    expect(Math.max(...counter.ids)).toBeLessThanOrEqual(50); // ids under the live count
    expect(warn.mock.calls.filter((c) => /maxBodies|add-body/.test(String(c[0])))).toEqual([]);
    expect(game.sandbox.dead).toBe(false);
  }, 60_000);

  it('still drops, with one warning, the bodies of a game that really holds more than maxBodies', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const gun = gunGame(50, 200);
    game = await createEngineRoomGame({
      definition: gun.definition,
      maxPlayers: 1,
      seed: 7,
      physicsOptions: { gravity: [0, 0, 0], maxBodies: MAX_BODIES },
    });
    const counter = countAdds(game);
    const before = gun.fired.n;
    for (let i = 0; i < 6; i += 1) game.tick(i * MS); // 200 alive: ids up to 200, past 127
    expect(counter.ids.length).toBeLessThan(gun.fired.n - before); // the ones past maxBodies dropped
    expect(counter.ids.every((id) => id <= MAX_BODIES)).toBe(true); // none past it reached Jolt
    expect(counter.ids).toContain(MAX_BODIES); // and a world for 128 holds 128
    expect(warn.mock.calls.filter((c) => String(c[0]).includes('maxBodies'))).toHaveLength(1);
  }, 60_000);
});
