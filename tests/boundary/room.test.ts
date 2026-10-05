/**
 * A room's game as `createEngineRoomGame` builds it from a wasm guest: the
 * real tiny-game component, two joined players, player 1 walking. Its world
 * must match the same game built from the definition (direct mode) exactly.
 *
 * ```sh
 * GAMEABLE_BOUNDARY=1 npx vitest run -c tests/boundary/vitest.config.ts room
 * ```
 */
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

import { describe, expect, it } from 'vitest';

import type { EngineRoomGame } from '@gameable/net/server';

import { BOUNDARY_ENABLED, ensureFixtureBuilt, FIXTURE_ASSETS, loadGameDefinition } from './harness.ts';

const MANIFEST = {
  version: 1,
  assets: FIXTURE_ASSETS.map((id) => ({ id, type: 'gltf', src: `${id}.glb` })),
};
const MS = 1000 / 60;

/**
 * Two players join; player 1 holds W for 120 ticks.
 *
 * @param game The room game.
 * @returns Every entity's position after the run, by id.
 */
async function walk(game: EngineRoomGame): Promise<[number, number[]][]> {
  const { keyIndex, writeKeyBit, KEY_WORDS } = await import('@gameable/sdk/keycodes');
  const keys = (): Uint32Array => new Uint32Array(KEY_WORDS);
  const w = {
    down: keys(),
    pressed: keys(),
    released: keys(),
    mods: { shift: false, ctrl: false, alt: false, meta: false, capsLock: false, numLock: false },
    mouse: { dx: 0, dy: 0, wheel: 0, buttons: 0, pressed: 0, released: 0 },
    focused: true,
  };
  writeKeyBit(w.down, keyIndex('W'), true);
  game.join(1, 'Ana', null);
  game.join(2, 'Ben', null);
  for (let i = 0; i < 120; i += 1) {
    game.input(1, i, w);
    game.tick(i * MS);
    game.viewFor(1);
    game.viewFor(2);
  }
  return [...game.adapter.world.entities.values()].map((r) => [r.entity, Array.from(r.position)]);
}

describe.skipIf(!BOUNDARY_ENABLED)('EngineRoomGame over the wasm guest', () => {
  it('walks player 1 exactly as direct mode does', async () => {
    const { createEngineRoomGame } = await import('@gameable/net/server');
    const { guestDir, guestEntry } = await ensureFixtureBuilt();
    const wasm = await createEngineRoomGame({
      guest: {
        guestModuleUrl: pathToFileURL(guestEntry).href,
        getCoreModule: async (path) => WebAssembly.compile(await readFile(`${guestDir}/${path}`)),
      },
      manifest: MANIFEST,
      maxPlayers: 4,
      seed: 7,
    });
    const direct = await createEngineRoomGame({
      definition: await loadGameDefinition(),
      manifest: MANIFEST,
      maxPlayers: 4,
      seed: 7,
    });
    const fromWasm = await walk(wasm);
    const fromDirect = await walk(direct);
    expect(wasm.sandbox.mode).toBe('wasm');
    expect(wasm.sandbox.dead).toBe(false);
    const one = wasm.entityOf(1);
    const walked = fromWasm.find(([e]) => e === one)?.[1] ?? [];
    expect(walked[2]).toBeLessThan(-3);
    expect(fromWasm).toEqual(fromDirect);
    wasm.dispose();
    direct.dispose();
    await Promise.all([wasm.disposed, direct.disposed]);
  });
});
