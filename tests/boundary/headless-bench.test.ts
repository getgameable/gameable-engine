/**
 * Rooms per core: N independent tiny-game authorities (each its own headless
 * engine, Jolt world, wasm instance and server loop) stepped round-robin in
 * one process, timing each whole round (every room, one tick).
 *
 * Gated behind `GAMEABLE_BOUNDARY=1` like the other boundary suites:
 *
 * ```sh
 * GAMEABLE_BOUNDARY=1 npx vitest run -c tests/boundary/vitest.config.ts headless-bench
 * ```
 */
import { afterAll, describe, expect, it } from 'vitest';

import type { HeadlessEngine } from '@gameable/core/headless';
import type { Sandbox } from '@gameable/wasm-host';
import type { InputSource } from '@gameable/wasm-host/server';

import { BOUNDARY_ENABLED, createWasmSandbox, FIXTURE_ASSETS } from './harness.ts';

/** Fixed steps each room takes: ten simulated seconds. */
const STEPS = 600;
/** Room counts measured. */
const ROOM_COUNTS = [1, 5, 10];
// 25 and 50 rooms were tried and are not measurable here. Observed: 10 rooms
// build, 12 abort with `Aborted(OOM)` at Jolt world creation, even with
// `maxBodies: 256`. Inferred, not observed: every world shares one wasm heap
// (`loadJolt` is a singleton), so the cap is per-world allocation.
/** One 60 Hz frame in milliseconds. */
const FRAME_MS = 1000 / 60;

interface Room {
  engine: HeadlessEngine;
  sandbox: Sandbox;
}

interface Row {
  rooms: number;
  p50: number;
  p99: number;
  perCore: number;
}

/** The value at quantile `q` of `values`. */
function pct(values: number[], q: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))] ?? 0;
}

describe.skipIf(!BOUNDARY_ENABLED)('headless rooms per core', () => {
  const rows: Row[] = [];
  /** Every engine created and not yet disposed, so a failed build still cleans up. */
  let live: HeadlessEngine[] = [];

  afterAll(async () => {
    if (rows.length > 0) {
      const lines = rows.map(
        (r) =>
          `| ${String(r.rooms).padStart(5)} | ${r.p50.toFixed(3).padStart(10)} | ` +
          `${r.p99.toFixed(3).padStart(10)} | ${String(r.perCore).padStart(16)} |`,
      );
      console.log(
        [
          `headless rooms per core (${String(STEPS)} ticks, round-robin):`,
          '| rooms | p50 ms/rnd | p99 ms/rnd | rooms/core @60Hz |',
          ...lines,
        ].join('\n'),
      );
    }
    await Promise.all(live.map((engine) => engine.dispose()));
    live = [];
  });

  /** Build one room: engine, adapter, host, sandbox and loop over the tiny game. */
  async function buildRoom(): Promise<Room & { frames: () => number }> {
    const { createHeadlessEngine } = await import('@gameable/core/headless');
    const { physics } = await import('@gameable/physics-jolt');
    const { createGameSlot } = await import('@gameable/wasm-host');
    const server = await import('@gameable/wasm-host/server');
    const harness = await import('@gameable/test-harness');

    const input = harness.createInputState();
    harness.press(input, 'W');
    const inputs: InputSource = { players: () => [0], snapshotFor: () => input };
    const slot = createGameSlot();
    const engine = await createHeadlessEngine({
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
    live.push(engine);
    const world = engine.modules.get('physics');
    const adapter = server.createServerAdapter(world);
    const host = server.createServerHost(world, engine.assets, adapter, { seed: 7 });
    const sandbox = await createWasmSandbox(host);
    await slot.attach(
      server.createServerLoop(engine, sandbox, adapter, inputs, { seed: 7 }),
      engine.ctx,
    );
    engine.step(0);
    return { engine, sandbox, frames: () => adapter.world.frame };
  }

  for (const rooms of ROOM_COUNTS) {
    it(`steps ${String(rooms)} room(s) for ${String(STEPS)} ticks`, async () => {
      try {
        const built = [];
        for (let i = 0; i < rooms; i += 1) built.push(await buildRoom());

        const rounds: number[] = [];
        for (let tick = 1; tick <= STEPS; tick += 1) {
          const t = tick * FRAME_MS;
          const started = performance.now();
          for (const room of built) room.engine.step(t);
          rounds.push(performance.now() - started);
        }

        expect(built.every((room) => !room.sandbox.dead && room.sandbox.error === null)).toBe(true);
        expect(built.every((room) => room.frames() === STEPS)).toBe(true);
        expect(rounds).toHaveLength(STEPS);

        const p99 = pct(rounds, 0.99);
        rows.push({
          rooms,
          p50: pct(rounds, 0.5),
          p99,
          perCore: Math.floor((rooms * FRAME_MS) / p99),
        });
      } finally {
        const engines = live;
        live = [];
        await Promise.all(engines.map((engine) => engine.dispose()));
      }
    }, 900_000);
  }
});
