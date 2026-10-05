/**
 * Body ids are the same in direct and wasm mode (3.8 fix round 2): the SDK's
 * free list (lowest freed id first) runs inside the guest in both, so the
 * churn fixture, which reorders that list every frame, hands Jolt the same ids
 * in the same order either way. One room at a time: the direct one is gone
 * before the wasm one starts.
 *
 * ```sh
 * GAMEABLE_BOUNDARY=1 npx vitest run -c tests/boundary/vitest.config.ts bodyIds
 * ```
 */
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

import { describe, expect, it } from 'vitest';

import { BOUNDARY_ENABLED, ensureFixtureBuilt, loadGameDefinition } from './harness.ts';

const MS = 1000 / 60;
const TICKS = 120;

type RoomGameLike = Awaited<ReturnType<typeof import('@gameable/net/server').createEngineRoomGame>>;

/**
 * @param game A room game.
 * @returns Per tick, the body ids Jolt was asked to add, from now on.
 */
function recordAdds(game: RoomGameLike): number[][] {
  const ticks: number[][] = [[]];
  const world = game.engine.modules.get('physics') as { addBody(body: { id: number }): void };
  const addBody = world.addBody.bind(world);
  world.addBody = (body: { id: number }) => {
    ticks[ticks.length - 1].push(body.id);
    addBody(body);
  };
  return ticks;
}

/**
 * @param game A room game.
 * @returns Every tick's added ids.
 */
async function run(game: RoomGameLike): Promise<number[][]> {
  const ticks = recordAdds(game);
  for (let i = 0; i < TICKS; i += 1) {
    game.tick(i * MS);
    ticks.push([]);
  }
  ticks.pop();
  game.dispose();
  await game.disposed;
  return ticks;
}

describe.skipIf(!BOUNDARY_ENABLED)('body ids, direct and wasm', () => {
  it('hands Jolt the same body ids in the same order in both modes, under the live count', async () => {
    const { createEngineRoomGame } = await import('@gameable/net/server');
    const { guestDir, guestEntry } = await ensureFixtureBuilt('churn');
    const definition = await loadGameDefinition('churn');
    const physicsOptions = { gravity: [0, 0, 0] as [number, number, number], maxBodies: 64 };

    const direct = await run(
      await createEngineRoomGame({ definition, maxPlayers: 1, seed: 7, physicsOptions }),
    );
    const wasm = await run(
      await createEngineRoomGame({
        guest: {
          guestModuleUrl: pathToFileURL(guestEntry).href,
          getCoreModule: async (path) => WebAssembly.compile(await readFile(`${guestDir}/${path}`)),
        },
        maxPlayers: 1,
        seed: 7,
        physicsOptions,
      }),
    );

    const all = direct.flat();
    expect(all.length).toBeGreaterThan(TICKS * 10); // the churn really ran: ~20 bodies a tick
    expect(wasm).toEqual(direct);
    expect(Math.max(...all)).toBeLessThanOrEqual(40);
  }, 120_000);
});
