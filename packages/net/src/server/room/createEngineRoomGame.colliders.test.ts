/**
 * Level colliders come from the manifest (3.10 review I4): every static
 * `collider` an entry declares is a Jolt body before the guest's `init`, in a
 * host-owned id range above the guest's `maxBodies`, counted into Jolt's body
 * limit. Solo and the room server get the level the same way, with no page or
 * server code. One direct room at a time: two direct runtimes must not share a realm.
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { defineGame, type GameContext, prefab } from '@gameable/sdk';
import { afterEach, describe, expect, it } from 'vitest';

import { createEngineRoomGame } from './createEngineRoomGame.js';
import type { EngineRoomGame } from './EngineRoomGame.js';

const MS = 1000 / 60;
/** The placeholder arena's collision mesh, as a file URL. */
const ARENA = new URL('../../../../assets-placeholder/assets/arena.collider.bin', import.meta.url).href;

/** A manifest whose arena declares the mesh collider, as `assets.json` does. */
const MANIFEST = {
  version: 1,
  baseUrl: '',
  assets: [
    { id: 'env.arena', type: 'splat', src: 'arena.spz', collider: { shape: 'mesh', src: ARENA, layer: 'static' } },
    { id: 'crate', type: 'gltf', src: 'c.glb', collider: { shape: 'box', halfExtents: [1, 1, 1], offset: [20, 1, 0] } },
    { id: 'ghost', type: 'gltf', src: 'g.glb', collider: { shape: 'sphere', radius: 1, layer: 'trigger' } },
  ],
};

/**
 * Reads the file URLs above, as `gameable serve` does.
 *
 * @param url A `file:` URL.
 * @returns The file's bytes.
 */
const readAsset = async (url: string): Promise<ArrayBuffer> => {
  const bytes = await readFile(fileURLToPath(url));
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
};

const Walker = prefab({
  name: 'walker',
  body: {
    shape: 'capsule',
    dims: [0.35, 0.8],
    kind: 'character',
    mass: 75,
    mask: { defaultLayer: true, staticGeometry: true },
    flags: { lockRotation: true, noSleep: true },
  },
});

/** What the guest saw during its own `init`. */
const seen = { floorAtInit: null as number | null };

const game0 = defineGame({
  features: { multiplayer: { maxPlayers: 2 } },
  world: { gravity: -9.81 },
  player: { prefab: Walker, spawn: [0, 1.5, 0] },
  init: (ctx: GameContext) => {
    // Down onto the box: every y = 0 triangle of the arena mesh faces down, and rays skip back faces.
    const hit = ctx.physics.raycast({ x: 20, y: 5, z: 0 }, { x: 0, y: -1, z: 0 }, 20);
    seen.floorAtInit = hit === null ? null : hit.distance;
  },
});

let game: EngineRoomGame | null = null;

afterEach(async () => {
  game?.dispose();
  await game?.disposed;
  game = null;
});

/**
 * @param room The room game.
 * @returns The joined player's entity height, from its welcome snapshot.
 */
function heightOf(room: EngineRoomGame): number {
  const snapshot = JSON.parse(room.snapshotFor(0)) as { entities: { entity: number; position: number[] }[] };
  const me = snapshot.entities.find((e) => e.entity === room.entityOf(0));
  if (me === undefined) throw new Error('the player has no entity');
  return me.position[1] ?? Number.NaN;
}

describe('createEngineRoomGame: level colliders from the manifest', () => {
  it("a player's character stands on the arena: two seconds in, it has not fallen through", async () => {
    game = await createEngineRoomGame({ definition: game0, manifest: MANIFEST, readAsset, seed: 7 });
    game.join(0, 'A', null);
    for (let i = 0; i < 120; i += 1) game.tick(i * MS);
    const y = heightOf(game);
    expect(y).toBeGreaterThan(-0.5); // free fall for 2 s would be about -18
    expect(y).toBeLessThan(2);
  }, 60_000);

  it("is in the world before the guest's init, in the host range above maxBodies", async () => {
    seen.floorAtInit = null;
    const added: number[] = [];
    game = await createEngineRoomGame({
      definition: game0,
      manifest: MANIFEST,
      readAsset,
      physicsOptions: { maxBodies: 64 },
      prepareWorld: (world) => {
        // prepareWorld runs after the level and before init: the level is already there.
        added.push(world.bodyCount);
      },
    });
    expect(seen.floorAtInit).not.toBeNull(); // init's raycast hit the floor
    expect(added).toEqual([2]); // the mesh and the box; the trigger is not static
    const world = game.engine.modules.get('physics') as unknown as {
      raycast(o: number[], d: number[], max: number, mask: number): { body: number } | null;
    };
    expect(world.raycast([4, -1, 4], [0, 1, 0], 20, 0xffff)?.body).toBe(65); // the mesh, from below: maxBodies + 1
    expect(world.raycast([20, 5, 0], [0, -1, 0], 20, 0xffff)?.body).toBe(66); // the box, at its offset
  }, 60_000);

  it('counts the level into Jolt: a guest still gets all of its maxBodies ids', async () => {
    const spawned = { n: 0 };
    const Ball = prefab({ name: 'ball', body: { shape: 'sphere', kind: 'dynamic', dims: [0.1] } });
    const full = defineGame({
      world: { gravity: 0, maxEntities: 256 },
      init: (ctx: GameContext) => {
        for (let i = 0; i < 64; i += 1) ctx.spawn(Ball, { x: i, y: 50, z: 0 });
        spawned.n = 64;
      },
    });
    game = await createEngineRoomGame({
      definition: full,
      maxPlayers: 1,
      manifest: MANIFEST,
      readAsset,
      physicsOptions: { maxBodies: 64, gravity: [0, 0, 0] },
    });
    game.tick(0);
    const world = game.engine.modules.get('physics');
    expect(spawned.n).toBe(64);
    expect(world.bodyCount).toBe(66); // 64 guest bodies and the 2 level bodies
  }, 60_000);

  it('a manifest collider that cannot be read fails the build, naming the asset', async () => {
    const broken = {
      ...MANIFEST,
      assets: [{ ...MANIFEST.assets[0], collider: { shape: 'mesh', src: 'file:///nowhere/x.bin' } }],
    };
    await expect(
      createEngineRoomGame({ definition: game0, manifest: broken, readAsset }),
    ).rejects.toThrow(/env\.arena/);
  }, 60_000);
});
