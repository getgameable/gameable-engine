import { describe, expect, it, vi } from 'vitest';
import { createHeadlessEngine } from '@gameable/core/headless';
import { physics } from '@gameable/physics-jolt';
import { createInputState, press } from '@gameable/test-harness';
import { defineGame } from '@gameable/sdk';
import type { GameDefinition, HostGameConfig } from '@gameable/sdk';

import { createGameSlot } from '../adapter/GameSlot';
import { createDirectSandbox, type Sandbox } from '../sandbox';
import { retainedHeap } from '../testing/collectGarbage';
import { createServerAdapter } from './createServerAdapter';
import { createServerHost } from './ServerHost';
import { createServerLoop } from './ServerLoop';
import type { InputSource } from './types';

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
 * Load the tiny-game fixture by URL, as `tests/boundary/harness.ts` does: it
 * lives outside this package, so a static import would leave the project's
 * `rootDir`.
 *
 * @returns The fixture's `defineGame` result.
 */
async function loadTinyGame(): Promise<GameDefinition> {
  const url = new URL('../../../../fixtures/tiny-game/src/game.ts', import.meta.url);
  return ((await import(url.href)) as { default: GameDefinition }).default;
}

/**
 * Boot the tiny game, direct mode, on a headless engine with Jolt and a server loop.
 *
 * @returns The engine, the adapter, the sandbox and player 0's input.
 */
async function bootTinyGame(): Promise<{
  engine: Awaited<ReturnType<typeof createHeadlessEngine>>;
  adapter: ReturnType<typeof createServerAdapter>;
  sandbox: Sandbox;
  input: ReturnType<typeof createInputState>;
}> {
  const input = createInputState();
  const inputs: InputSource = { players: () => [0], snapshotFor: () => input };
  const slot = createGameSlot();
  const engine = await createHeadlessEngine({
    manifest: MANIFEST,
    modules: [physics({ gravity: [0, -9.81, 0] }), slot.module],
  });
  const world = engine.modules.get('physics');
  const adapter = createServerAdapter(world);
  const host = createServerHost(world, engine.assets, adapter, { seed: 7 });
  const sandbox = createDirectSandbox({ mode: 'direct', game: await loadTinyGame(), host });
  await slot.attach(createServerLoop(engine, sandbox, adapter, inputs, { seed: 7 }), engine.ctx);
  // The authority spawns `player` per joined player; a room emits this when the seat is taken.
  adapter.events.push({ tag: 'player-joined', val: { player: 0, name: 'solo', data: undefined } });
  return { engine, adapter, sandbox, input };
}

describe('createServerLoop', () => {
  it('runs the tiny game headless for 300 steps with one walking player', async () => {
    const { engine, adapter, sandbox, input } = await bootTinyGame();

    engine.step(0);
    press(input, 'W');
    for (let i = 1; i <= 300; i += 1) engine.step(i * (1000 / 60));

    expect(sandbox.dead).toBe(false);
    // The player plus three enemies.
    expect(adapter.world.entities.size).toBe(4);
    const player = [...adapter.world.entities.values()].find((e) => e.name === 'player');
    expect(player?.body).toBeDefined();
    // Yaw 0 walks -Z at 4 m/s. There is no floor, so it walks while it falls:
    // about 15 m in five simulated seconds (observed -14.8).
    expect(player!.position[2]).toBeLessThan(-5);
    await engine.dispose();
  }, 60_000);

  it('allocates nothing per fixed step once it is warm', async () => {
    const { engine, sandbox, input } = await bootTinyGame();
    engine.step(0);
    press(input, 'W');
    let now = 0;
    const step = (): void => {
      now += 1000 / 60;
      engine.step(now);
    };

    // Warm up, then a baseline: the first ~5,000 steps still settle (they
    // retain ~100-160 KB per 1,500 and then stop), so the measured window
    // starts after them.
    for (let i = 0; i < 6000; i += 1) step();
    const before = retainedHeap();
    for (let i = 0; i < 1500; i += 1) step();
    const after = retainedHeap();

    expect(sandbox.dead).toBe(false);
    // Both readings follow a real collection, so only retained bytes count.
    // This covers the whole step: loop, guest, adapter and Jolt. A settled
    // window retains nothing; 128 KB catches anything keeping ~90 bytes a
    // step, as HostLoop's test does.
    expect(after - before).toBeLessThan(128 * 1024);
    await engine.dispose();
  }, 60_000);

  it('initialises the guest as the authority, keeping the caller options', async () => {
    let seen: HostGameConfig | undefined;
    const sandbox = {
      init: (config: HostGameConfig) => {
        seen = config;
      },
      dead: false,
    } as unknown as Sandbox;
    const engine = await createHeadlessEngine({ modules: [physics()] });
    const adapter = createServerAdapter(engine.modules.get('physics'));
    const inputs: InputSource = { players: () => [], snapshotFor: () => createInputState() };
    const loop = createServerLoop(engine, sandbox, adapter, inputs, {
      seed: 9,
      options: '{"mode":"duel","net":{"tickRate":30}}',
    });
    loop.init(engine.ctx);
    expect(seen?.seed).toBe(9n);
    expect(seen?.fixedHz).toBe(60);
    expect(JSON.parse(seen?.options ?? '')).toEqual({
      mode: 'duel',
      net: { tickRate: 30, role: 'authority' },
    });
    await engine.dispose();
  });

  it('rejects caller options that are not a JSON object', async () => {
    const engine = await createHeadlessEngine({ modules: [physics()] });
    const adapter = createServerAdapter(engine.modules.get('physics'));
    const inputs: InputSource = { players: () => [], snapshotFor: () => createInputState() };
    const sandbox = { init: () => undefined, dead: false } as unknown as Sandbox;
    const loop = createServerLoop(engine, sandbox, adapter, inputs, { options: '[1]' });
    expect(() => {
      loop.init(engine.ctx);
    }).toThrow(/JSON object/);
    await engine.dispose();
  });

  it('hands the guest every player in the room, each with its own input', async () => {
    const seen: [number, number, boolean][] = [];
    const game = defineGame({
      update: (ctx) => {
        for (const [id, player] of ctx.players)
          seen.push([id, player.seq, player.input.isDown('W')]);
      },
    });
    const zero = createInputState();
    const two = createInputState();
    press(two, 'W');
    const inputs: InputSource = {
      players: () => [0, 2],
      snapshotFor: (id) => (id === 2 ? two : zero),
      seqFor: (id) => id * 10,
    };
    const slot = createGameSlot();
    const engine = await createHeadlessEngine({ modules: [physics(), slot.module] });
    const world = engine.modules.get('physics');
    const adapter = createServerAdapter(world);
    const host = createServerHost(world, engine.assets, adapter, { seed: 7 });
    const sandbox = createDirectSandbox({ mode: 'direct', game, host });
    await slot.attach(createServerLoop(engine, sandbox, adapter, inputs), engine.ctx);
    engine.step(0);
    engine.step(1000 / 60);
    expect(seen.slice(0, 2)).toEqual([
      [0, 0, false],
      [2, 20, true],
    ]);
    await engine.dispose();
  });
  it('warns once in dev mode when players() is not ascending', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const game = defineGame({ update: () => undefined });
    const input = createInputState();
    const order = [2, 0];
    const inputs: InputSource = { players: () => order, snapshotFor: () => input };
    const slot = createGameSlot();
    const engine = await createHeadlessEngine({ modules: [physics(), slot.module] });
    const world = engine.modules.get('physics');
    const adapter = createServerAdapter(world);
    const host = createServerHost(world, engine.assets, adapter, { seed: 7 });
    const sandbox = createDirectSandbox({ mode: 'direct', game, host });
    const loop = createServerLoop(engine, sandbox, adapter, inputs, { devMode: true });
    await slot.attach(loop, engine.ctx);
    for (let i = 0; i < 4; i += 1) engine.step(i * (1000 / 60));
    const ordered = warn.mock.calls.filter((c) => String(c[0]).includes('ascending'));
    expect(ordered).toHaveLength(1);
    warn.mockRestore();
    await engine.dispose();
  });

  it('says nothing about order outside dev mode', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const game = defineGame({ update: () => undefined });
    const input = createInputState();
    const inputs: InputSource = { players: () => [2, 0], snapshotFor: () => input };
    const slot = createGameSlot();
    const engine = await createHeadlessEngine({ modules: [physics(), slot.module] });
    const world = engine.modules.get('physics');
    const adapter = createServerAdapter(world);
    const host = createServerHost(world, engine.assets, adapter, { seed: 7 });
    const sandbox = createDirectSandbox({ mode: 'direct', game, host });
    await slot.attach(createServerLoop(engine, sandbox, adapter, inputs), engine.ctx);
    for (let i = 0; i < 2; i += 1) engine.step(i * (1000 / 60));
    expect(warn.mock.calls.some((c) => String(c[0]).includes('ascending'))).toBe(false);
    warn.mockRestore();
    await engine.dispose();
  });
});
