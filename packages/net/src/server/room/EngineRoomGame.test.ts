import { keyIndex, keyIndex2, writeKeyBit } from '@gameable/sdk/keycodes';
import { defineGame, type GameDefinition } from '@gameable/sdk';
import { describe, expect, it } from 'vitest';

import { createEngineRoomGame } from './createEngineRoomGame.js';
import type { EngineRoomGame } from './EngineRoomGame.js';
import { blankInput } from './roomTesting.js';

/** The manifest the tiny game asks for, by id. */
const MANIFEST = {
  version: 1,
  assets: [
    { id: 'arena', type: 'splat', src: 'a.spz' },
    { id: 'enemy-capsule', type: 'gltf', src: 'e.glb' },
    { id: 'shot', type: 'audio', src: 's.wav' },
  ],
};

/**
 * Load the tiny-game fixture by URL, as the server loop's test does: it lives
 * outside this package, so a static import would leave the project's `rootDir`.
 *
 * @returns The fixture's `defineGame` result.
 */
async function loadTinyGame(): Promise<GameDefinition> {
  const url = new URL('../../../../../fixtures/tiny-game/src/game.ts', import.meta.url);
  return ((await import(url.href)) as { default: GameDefinition }).default;
}

const MS = 1000 / 60;

/**
 * @param game The room game.
 * @param from The first tick's index.
 * @param count Ticks to run.
 * @param spawned Spawned entity ids per player, filled from every view.
 */
function run(game: EngineRoomGame, from: number, count: number, spawned: Map<number, Set<number>>): void {
  for (let i = from; i < from + count; i += 1) {
    game.tick(i * MS);
    for (const player of [1, 2]) {
      const seen = spawned.get(player) ?? new Set<number>();
      spawned.set(player, seen);
      for (const command of game.viewFor(player).commands) {
        if (command.tag === 'spawn') seen.add(command.val.entity);
      }
    }
  }
}

describe('EngineRoomGame', () => {
  it('registers only physics and the game slot: no input, audio or splat module', async () => {
    const game = await createEngineRoomGame({
      definition: await loadTinyGame(),
      manifest: MANIFEST,
      maxPlayers: 4,
      seed: 7,
    });
    expect(game.engine.modules.modules.map((m) => m.id).sort()).toEqual(['game', 'physics']);
    game.dispose();
    await game.disposed;
  }, 60_000);

  it('runs the tiny game for two players: both see both, and W moves only its own entity', async () => {
    const game = await createEngineRoomGame({
      definition: await loadTinyGame(),
      manifest: MANIFEST,
      physicsOptions: { gravity: [0, -9.81, 0] },
      maxPlayers: 4,
      seed: 7,
    });
    game.join(1, 'Ana', null);
    game.join(2, 'Ben', null);
    const welcome = JSON.parse(game.snapshotFor(1)) as { entities: unknown[] };
    expect(welcome.entities.length).toBeGreaterThan(0); // the three enemies, spawned in init
    game.snapshotFor(2);
    const spawned = new Map<number, Set<number>>();
    run(game, 0, 60, spawned);

    const one = game.entityOf(1);
    const two = game.entityOf(2);
    expect(one).not.toBe(0);
    expect(two).not.toBe(0);
    expect(one).not.toBe(two);
    for (const player of [1, 2]) {
      expect(spawned.get(player)?.has(one)).toBe(true);
      expect(spawned.get(player)?.has(two)).toBe(true);
    }

    const world = game.adapter.world;
    // The guest named the player prefabs, not the enemies init spawned.
    expect(world.get(one)?.name).toBe('player');
    expect(world.get(two)?.name).toBe('player');
    const startOne = world.get(one)?.position[2] ?? 0;
    const startTwo = Array.from(world.get(two)?.position ?? []);
    game.viewFor(2).takeRows();
    const w = blankInput();
    for (const index of [keyIndex('W'), keyIndex2('W')]) {
      if (index < 0) continue;
      writeKeyBit(w.down, index, true);
      writeKeyBit(w.pressed, index, true);
    }
    for (let i = 60; i < 120; i += 1) {
      game.input(1, i, w);
      w.pressed.fill(0);
      game.tick(i * MS);
    }
    const endOne = world.get(one)?.position[2] ?? 0;
    const endTwo = Array.from(world.get(two)?.position ?? []);
    // Yaw 0 walks -Z at 4 m/s: about 4 m in a simulated second.
    expect(endOne).toBeLessThan(startOne - 2);
    expect(endTwo[0]).toBeCloseTo(startTwo[0], 3);
    expect(endTwo[2]).toBeCloseTo(startTwo[2], 3);
    // Player 2's rows carry player 1's walk.
    const rows = game.viewFor(2).takeRows();
    const entities: number[] = [];
    for (let i = 0; i < rows.count; i += 1) entities.push(rows.entity(i));
    expect(entities).toContain(one);
    expect(game.sandbox.dead).toBe(false);
    game.dispose();
    await game.disposed;
  }, 60_000);

  it('despawns a leaving player for the others', async () => {
    const game = await createEngineRoomGame({
      definition: await loadTinyGame(),
      manifest: MANIFEST,
      maxPlayers: 4,
      seed: 7,
    });
    game.join(1, 'Ana', null);
    game.join(2, 'Ben', null);
    const spawned = new Map<number, Set<number>>();
    run(game, 0, 5, spawned);
    const two = game.entityOf(2);
    game.leave(2, 'timeout');
    game.tick(5 * MS);
    game.tick(6 * MS);
    const despawns = game
      .viewFor(1)
      .commands.filter((c) => c.tag === 'despawn')
      .map((c) => c.val);
    expect(despawns).toContain(two);
    game.dispose();
    await game.disposed;
  }, 60_000);
});

describe('EngineRoomGame: fix round 1', () => {
  it('maps out-of-order joins to their own entities (the guest says which), and none past the guest cap', async () => {
    // Three seats: ids 0..2 (Room.seats.test.ts pins that seat 3 is past them).
    const game = await createEngineRoomGame({ definition: await loadTinyGame(), manifest: MANIFEST, maxPlayers: 3, seed: 7 });
    game.join(5, 'Over', null); // past the seats: the guest spawns nothing for it
    game.join(2, 'C', null);
    game.join(0, 'A', null);
    game.tick(0);
    game.tick(MS);
    const two = game.entityOf(2);
    const zero = game.entityOf(0);
    expect(game.entityOf(5)).toBe(0);
    expect(game.adapter.world.get(two)?.name).toBe('player');
    expect(game.adapter.world.get(zero)?.name).toBe('player');
    // The guest spawns in event order, so player 2's entity was minted first.
    expect(two).toBeLessThan(zero);
    game.dispose();
    await game.disposed;
  }, 60_000);

  it('acks only input a simulation step has applied', async () => {
    const game = await createEngineRoomGame({ definition: await loadTinyGame(), manifest: MANIFEST, maxPlayers: 4, seed: 7 });
    game.join(0, 'A', null);
    game.tick(0);
    game.input(0, 7, blankInput());
    game.tick(0); // the same instant: no step runs
    expect(game.ackFor(0)).toBe(0);
    game.tick(MS);
    expect(game.ackFor(0)).toBe(7);
    game.dispose();
    await game.disposed;
  }, 60_000);

  it('a guest that dies ends the game as crashed', async () => {
    // A system's throw is caught and logged by the runtime; spawning the
    // player prefab on a join is not, so a prefab that throws kills the guest.
    const broken = {
      name: 'broken',
      get components(): never {
        throw new Error('boom');
      },
    };
    const definition = defineGame({ player: { prefab: broken as never } });
    const game = await createEngineRoomGame({ definition, maxPlayers: 4, seed: 7 });
    game.join(0, 'A', null);
    for (let i = 0; i < 3; i += 1) game.tick(i * MS);
    expect(game.sandbox.dead).toBe(true);
    expect(game.ended).toBe('crashed');
    game.dispose();
    await game.disposed;
  }, 60_000);

  it('fails loudly when the guest dies during the warm-up step (R4)', async () => {
    // A stand-in for a transpiled guest whose first tick traps.
    const src =
      'export async function instantiate() { return { "gameable:engine/game@0.2.0": { init() {}, ' +
      'tick() { throw new Error("trap"); }, shutdown() {}, ' +
      'snapshot() { return new Uint8Array(0); }, restore() {} } }; }';
    const guest = {
      guestModuleUrl: `data:text/javascript,${encodeURIComponent(src)}`,
      getCoreModule: (): Promise<WebAssembly.Module> => Promise.reject(new Error('no core modules')),
    };
    await expect(createEngineRoomGame({ guest, maxPlayers: 2 })).rejects.toThrow(
      /died during its first step: .*trap/,
    );
  }, 60_000);
});
