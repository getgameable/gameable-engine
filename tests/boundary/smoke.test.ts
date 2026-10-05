/**
 * The boundary smoke test: build the real component and drive it.
 *
 * Slow (a cold componentize is ~30 s), so it is gated behind `GAMEABLE_BOUNDARY=1`
 * and skipped by the root `npm test`. Run it with:
 *
 * ```sh
 * GAMEABLE_BOUNDARY=1 npx vitest run -c tests/boundary/vitest.config.ts
 * ```
 */
import { beforeAll, describe, expect, it } from 'vitest';

import { BOUNDARY_ENABLED, createBoundaryHost, createWasmSandbox } from './harness.ts';
import type { Sandbox } from '@gameable/wasm-host';
import type { MockHost } from '@gameable/test-harness';

describe.skipIf(!BOUNDARY_ENABLED)('wasm boundary smoke', () => {
  let sandbox: Sandbox;
  let host: MockHost;
  let harness: typeof import('@gameable/test-harness');
  let adapter: import('@gameable/wasm-host').NullAdapter;
  let applyOutput: typeof import('@gameable/wasm-host').applyOutput;

  /** Per-frame wall time of the 120 ticks, for the timing report. */
  const tickMs: number[] = [];
  /** Command tags seen on each frame. */
  const tagsByFrame: string[][] = [];
  /** HUD payloads and the frames they crossed on. */
  const hudFrames: { frame: number; json: string }[] = [];
  /** Transform row counts per frame. */
  const rowsByFrame: number[] = [];
  /** Milliseconds the instantiate took. */
  let instantiateMs = 0;
  /** Steady-state tick times, measured after a warm-up pass. */
  const steadyMs: number[] = [];

  beforeAll(async () => {
    harness = await import('@gameable/test-harness');
    const wasmHost = await import('@gameable/wasm-host');
    applyOutput = wasmHost.applyOutput;
    adapter = wasmHost.NullEngineAdapter();

    host = await createBoundaryHost();
    const started = performance.now();
    sandbox = await createWasmSandbox(host);
    instantiateMs = performance.now() - started;

    sandbox.init(harness.createGameConfig({ seed: 0xa05en, fixedHz: 60 }));

    const input = harness.createInputState();
    for (let frame = 0; frame < 120; frame += 1) {
      // Walk forward from frame 10, fire once on frame 40.
      if (frame === 10) harness.press(input, 'W');
      if (frame === 40) harness.pressMouse(input, 1);
      if (frame === 41) harness.releaseMouse(input, 1);
      input.mouse.dx = frame === 20 ? 40 : 0;

      const frameInput = harness.createFrameInput({ frame, input });
      const started2 = performance.now();
      const out = sandbox.tick(frameInput);
      tickMs.push(performance.now() - started2);

      tagsByFrame.push(out.commands.map((c) => c.tag));
      rowsByFrame.push(out.transforms.length / 12);
      if (out.hud !== undefined && out.hud !== null) hudFrames.push({ frame, json: out.hud });
      applyOutput(adapter, out);
      harness.endFrame(input);
    }

    // Steady state: the first ticks pay for QuickJS warm-up and V8 JIT, so
    // measure again once both are hot. This is the number the perf budget
    // tracks.
    const steadyInput = harness.createFrameInput({ frame: 200, input });
    for (let i = 0; i < 300; i += 1) sandbox.tick(steadyInput);
    for (let i = 0; i < 1000; i += 1) {
      const started2 = performance.now();
      sandbox.tick(steadyInput);
      steadyMs.push(performance.now() - started2);
    }
  }, 600_000);

  it('instantiates without dying', () => {
    expect(sandbox.dead).toBe(false);
    expect(sandbox.error).toBeNull();
  });

  it('emits spawn and add-body commands on frame 0', () => {
    const frame0 = tagsByFrame[0] ?? [];
    // One player plus three enemies, each with a body.
    expect(frame0.filter((t) => t === 'spawn')).toHaveLength(4);
    expect(frame0.filter((t) => t === 'add-body')).toHaveLength(4);
    // Nothing structural after the first frame: the only per-frame command is
    // the character drive, which the game issues unconditionally.
    for (let frame = 1; frame < 40; frame += 1) {
      expect(tagsByFrame[frame]).toEqual(['move-character']);
    }
  });

  it('routes every frame-0 command through the adapter', () => {
    expect(adapter.by('spawn')).toHaveLength(4);
    expect(adapter.by('addBody')).toHaveLength(4);
    expect(adapter.by('applyTransforms').length).toBe(120);
  });

  it('packs transforms at stride 12', () => {
    for (const rows of rowsByFrame) expect(Number.isInteger(rows)).toBe(true);
    // Frame 0 spawns four entities, so four rows are dirty.
    expect(rowsByFrame[0]).toBe(4);
    // Later frames emit at least the placeholder row.
    expect(rowsByFrame[60]).toBeGreaterThanOrEqual(1);
  });

  it('round-trips a synchronous raycast import', () => {
    expect(host.rayCalls.raycast).toBe(1);
    // The hitscan also plays a sound, which is the only late command.
    expect(tagsByFrame[40]).toContain('play-sound');
  });

  it('emits the HUD only when it changes', () => {
    const frames = hudFrames.map((h) => h.frame);
    expect(frames).toEqual([0, 30, 60, 90]);
    const first = JSON.parse(hudFrames[0]!.json) as { health: number; enemies: number };
    expect(first.health).toBe(100);
    expect(first.enemies).toBe(3);
  });

  it('resolves manifest names through the assets import', () => {
    expect(host.warnings().filter((l) => l.msg.includes('not in the manifest'))).toHaveLength(0);
  });

  it('survives a snapshot and restore round trip', () => {
    const snapshot = sandbox.snapshot();
    expect(snapshot.byteLength).toBeGreaterThan(64);

    const before = sandbox.tick(harness.createFrameInput({ frame: 120 }));
    const hashBefore = harness.hashFrameOutput(before);

    sandbox.restore(snapshot);
    const after = sandbox.tick(harness.createFrameInput({ frame: 120 }));
    expect(harness.hashFrameOutput(after)).toBe(hashBefore);
    expect(sandbox.dead).toBe(false);
  });

  it('reports its timings', () => {
    const pct = (values: number[], q: number): number => {
      const sorted = [...values].sort((a, b) => a - b);
      return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))] ?? 0;
    };
    console.log(
      `boundary smoke: instantiate ${instantiateMs.toFixed(1)} ms | ` +
        `cold tick p50 ${pct(tickMs, 0.5).toFixed(3)} ms, p99 ${pct(tickMs, 0.99).toFixed(3)} ms | ` +
        `steady tick p50 ${pct(steadyMs, 0.5).toFixed(3)} ms, ` +
        `p90 ${pct(steadyMs, 0.9).toFixed(3)} ms, ` +
        `p99 ${pct(steadyMs, 0.99).toFixed(3)} ms`,
    );
    // Generous: this is a smoke test, not the perf gate.
    expect(pct(steadyMs, 0.5)).toBeLessThan(5);
  });
});
