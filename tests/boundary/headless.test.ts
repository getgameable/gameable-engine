/**
 * The tiny game as an authority runs it: the real wasm component on a headless
 * engine with Jolt, its host the real `createServerHost`, its output applied
 * to a server adapter's world record. No three.js, no page.
 *
 * Gated behind `GAMEABLE_BOUNDARY=1` like the other boundary suites:
 *
 * ```sh
 * GAMEABLE_BOUNDARY=1 npx vitest run -c tests/boundary/vitest.config.ts headless
 * ```
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { HeadlessEngine } from '@gameable/core/headless';
import type { Sandbox } from '@gameable/wasm-host';
import type { InputSource, ServerAdapter } from '@gameable/wasm-host/server';

import { BOUNDARY_ENABLED, createWasmSandbox, FIXTURE_ASSETS } from './harness.ts';

/** Fixed steps the run takes: ten simulated seconds. */
const STEPS = 600;

describe.skipIf(!BOUNDARY_ENABLED)('wasm guest on a headless authority', () => {
  let engine: HeadlessEngine;
  let sandbox: Sandbox;
  let adapter: ServerAdapter;
  /** Wall time of each `engine.step`: one guest tick plus one Jolt step. */
  const stepMs: number[] = [];
  /** Wall time of each guest `tick` alone, across the wasm boundary. */
  const tickMs: number[] = [];

  beforeAll(async () => {
    const { createHeadlessEngine } = await import('@gameable/core/headless');
    const { physics } = await import('@gameable/physics-jolt');
    const { createGameSlot } = await import('@gameable/wasm-host');
    const server = await import('@gameable/wasm-host/server');
    const harness = await import('@gameable/test-harness');

    const input = harness.createInputState();
    const inputs: InputSource = { players: () => [0], snapshotFor: () => input };
    const slot = createGameSlot();
    engine = await createHeadlessEngine({
      manifest: {
        version: 1,
        assets: FIXTURE_ASSETS.map((id) => ({
          id,
          type: id === 'shot' ? 'audio' : id === 'arena' ? 'splat' : 'gltf',
          src: `${id}.bin`,
        })),
      },
      modules: [physics({ gravity: [0, -9.81, 0] }), slot.module],
    });
    const world = engine.modules.get('physics');
    adapter = server.createServerAdapter(world);
    const host = server.createServerHost(world, engine.assets, adapter, { seed: 7 });
    sandbox = await createWasmSandbox(host);
    const guest = sandbox;
    // The loop ticks this wrapper, so the guest's own share of a step is timed.
    const timed: Sandbox = {
      mode: guest.mode,
      init: (config) => {
        guest.init(config);
      },
      tick: (frameInput) => {
        const started = performance.now();
        const out = guest.tick(frameInput);
        tickMs.push(performance.now() - started);
        return out;
      },
      shutdown: () => {
        guest.shutdown();
      },
      snapshot: () => guest.snapshot(),
      restore: (state) => {
        guest.restore(state);
      },
      get dead() {
        return guest.dead;
      },
      get error() {
        return guest.error;
      },
    };
    await slot.attach(
      server.createServerLoop(engine, timed, adapter, inputs, { seed: 7 }),
      engine.ctx,
    );

    // A room's authority spawns `player` per joined player; the room (Task 3.6)
    // emits this when the seat is taken.
    adapter.events.push({
      tag: 'player-joined',
      val: { player: 0, name: 'solo', data: undefined },
    });
    engine.step(0);
    harness.press(input, 'W');
    for (let i = 1; i <= STEPS; i += 1) {
      const started = performance.now();
      engine.step(i * (1000 / 60));
      stepMs.push(performance.now() - started);
    }
  }, 600_000);

  afterAll(async () => {
    await engine?.dispose();
  });

  it('stays alive for every step', () => {
    expect(sandbox.dead).toBe(false);
    expect(sandbox.error).toBeNull();
    expect(adapter.world.frame).toBe(STEPS);
  });

  it('keeps the player and the three enemies, and walks the player', () => {
    expect(adapter.world.entities.size).toBe(4);
    const player = [...adapter.world.entities.values()].find((e) => e.name === 'player');
    expect(player?.body).toBeDefined();
    expect(player!.position[2]).toBeLessThan(-5);
  });

  it('reports its timings', () => {
    const pct = (values: number[], q: number): number => {
      const sorted = [...values].sort((a, b) => a - b);
      return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))] ?? 0;
    };
    const player = [...adapter.world.entities.values()].find((e) => e.name === 'player');
    console.log(
      `boundary headless: ${String(STEPS)} steps | guest tick ` +
        `p50 ${pct(tickMs, 0.5).toFixed(3)} ms, p99 ${pct(tickMs, 0.99).toFixed(3)} ms | ` +
        `whole step (tick + Jolt) p50 ${pct(stepMs, 0.5).toFixed(3)} ms, ` +
        `p99 ${pct(stepMs, 0.99).toFixed(3)} ms | player z ${String(player?.position[2])}`,
    );
    expect(tickMs).toHaveLength(STEPS);
    // Generous: a smoke bound, not the perf gate.
    expect(pct(stepMs, 0.5)).toBeLessThan(16);
  });
});
