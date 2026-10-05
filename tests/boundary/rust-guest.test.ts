/**
 * The Rust guest crosses the same boundary as the TypeScript one.
 *
 * `examples/wasm-guest-rust` is built by `cargo build --target wasm32-wasip2`
 * and transpiled with the identical `jco transpile` flags, then loaded through
 * the identical `createSandbox({ mode: 'wasm' })`. Nothing in
 * `@gameable/wasm-host` knows which language produced the component — that is
 * the whole point of the test.
 *
 * Gated behind `GAMEABLE_BOUNDARY=1` like the rest of the suite, and skipped with a
 * message when the Rust toolchain is not installed:
 *
 * ```sh
 * GAMEABLE_BOUNDARY=1 npx vitest run -c tests/boundary/vitest.config.ts tests/boundary/rust-guest.test.ts
 * ```
 */
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';

import { BOUNDARY_ENABLED } from './harness.ts';
import type { Sandbox } from '@gameable/wasm-host';
import type { MockHost } from '@gameable/test-harness';

/** The build helper, imported lazily so a skipped run never spawns cargo. */
interface BuildModule {
  buildRustGuest: (options?: { force?: boolean; quiet?: boolean }) => {
    built: boolean;
    guestEntry: string;
    guestDir: string;
    component: string;
  };
  checkToolchain: () => { ok: boolean; reason: string; cargo: string };
}

const buildUrl = new URL('../../examples/wasm-guest-rust/build.mjs', import.meta.url);

/**
 * Decide up front whether this suite can run at all. `describe.skipIf` needs a
 * synchronous answer, and a top-level await is the cheapest way to get one.
 */
const toolchain: { ok: boolean; reason: string; cargo: string } = BOUNDARY_ENABLED
  ? ((await import(buildUrl.href)) as BuildModule).checkToolchain()
  : { ok: false, reason: 'boundary tests are off; set GAMEABLE_BOUNDARY=1', cargo: '' };

if (BOUNDARY_ENABLED && !toolchain.ok) {
  console.log(`rust guest: SKIPPED — ${toolchain.reason}`);
}

/** The manifest the guest resolves in `init`. */
const ASSETS = ['rust-crate', 'rust-shot'];
/** Entities and bodies the guest mints: player 1, boxes 2..4. */
const EXPECTED_SPAWNS = 4;
/** `frame-output.transforms` stride. */
const STRIDE = 12;

describe.skipIf(!BOUNDARY_ENABLED || !toolchain.ok)('rust guest at the wasm boundary', () => {
  let sandbox: Sandbox;
  let host: MockHost;
  let harness: typeof import('@gameable/test-harness');
  let adapter: import('@gameable/wasm-host').NullAdapter;

  /** Command tags seen on each frame. */
  const tagsByFrame: string[][] = [];
  /** Transform row counts per frame. */
  const rowsByFrame: number[] = [];
  /** HUD payloads and the frames they crossed on. */
  const hudFrames: { frame: number; json: string }[] = [];
  /** Milliseconds the instantiate took. */
  let instantiateMs = 0;
  /** Cold tick times over the 120 scripted frames. */
  const tickMs: number[] = [];
  /** Steady-state tick times, measured after a warm-up pass. */
  const steadyMs: number[] = [];

  beforeAll(async () => {
    harness = await import('@gameable/test-harness');
    const wasmHost = await import('@gameable/wasm-host');
    adapter = wasmHost.NullEngineAdapter();

    const build = (await import(buildUrl.href)) as BuildModule;
    const { guestDir, guestEntry } = build.buildRustGuest({ quiet: true });

    host = harness.createMockHost({
      seed: 0xa05e,
      nowMs: () => 0,
      assets: ASSETS,
      strictAssets: true,
      // A scripted hitscan, exactly as the tiny-game boundary host does.
      raycast: (origin, direction) => ({
        body: 3,
        entity: 3,
        point: { x: origin.x + direction.x, y: origin.y + direction.y, z: origin.z + direction.z },
        normal: { x: 0, y: 0, z: 1 },
        distance: 7.5,
      }),
    });

    const cache = new Map<string, Promise<WebAssembly.Module>>();
    const getCoreModule = (path: string): Promise<WebAssembly.Module> => {
      const key = `${guestDir}/${path}`;
      let pending = cache.get(key);
      if (!pending) {
        pending = readFile(key).then((bytes) => WebAssembly.compile(bytes));
        cache.set(key, pending);
      }
      return pending;
    };

    const started = performance.now();
    sandbox = await wasmHost.createSandbox({
      mode: 'wasm',
      guestModuleUrl: pathToFileURL(guestEntry).href,
      getCoreModule,
      host,
      wasi: {
        stderr: (bytes: Uint8Array) => {
          const text = new TextDecoder().decode(bytes).replace(/\n$/, '');
          if (text.length > 0) host.log('error', `guest stderr: ${text}`);
        },
      },
    });
    instantiateMs = performance.now() - started;

    sandbox.init(harness.createGameConfig({ seed: 0xa05en, fixedHz: 60 }));

    // One body row for the player, fed from frame 60 on, so the ingest path is
    // exercised: the guest must read stride 15 and take the host's position.
    const bodies = harness.packBodies([{ body: 1, position: [2, 1, -3] }]);
    const input = harness.createInputState();

    for (let frame = 0; frame < 120; frame += 1) {
      if (frame === 10) harness.press(input, 'W');
      if (frame === 40) harness.pressMouse(input, 1);
      if (frame === 41) harness.releaseMouse(input, 1);
      input.mouse.dx = frame === 20 ? 40 : 0;

      const frameInput = harness.createFrameInput({
        frame,
        input,
        bodies: frame >= 60 ? bodies : undefined,
      });
      const t0 = performance.now();
      const out = sandbox.tick(frameInput);
      tickMs.push(performance.now() - t0);

      tagsByFrame.push(out.commands.map((c) => c.tag));
      rowsByFrame.push(out.transforms.length / STRIDE);
      if (out.hud !== undefined && out.hud !== null) hudFrames.push({ frame, json: out.hud });
      wasmHost.applyOutput(adapter, out);
      harness.endFrame(input);
    }

    // Steady state: measure once V8 has JITted the generated bindings.
    const steadyInput = harness.createFrameInput({ frame: 200, input });
    for (let i = 0; i < 300; i += 1) sandbox.tick(steadyInput);
    for (let i = 0; i < 1000; i += 1) {
      const t0 = performance.now();
      sandbox.tick(steadyInput);
      steadyMs.push(performance.now() - t0);
    }
  }, 600_000);

  it('instantiates a Rust component without dying', () => {
    expect(sandbox.mode).toBe('wasm');
    expect(sandbox.dead).toBe(false);
    expect(sandbox.error).toBeNull();
  });

  it('emits spawn and add-body commands on frame 0 only', () => {
    const frame0 = tagsByFrame[0] ?? [];
    expect(frame0.filter((t) => t === 'spawn')).toHaveLength(EXPECTED_SPAWNS);
    expect(frame0.filter((t) => t === 'add-body')).toHaveLength(EXPECTED_SPAWNS);
    // The character drive is the only unconditional per-frame command.
    expect(frame0.at(-1)).toBe('move-character');
    for (let frame = 1; frame < 40; frame += 1) {
      expect(tagsByFrame[frame]).toEqual(['move-character']);
    }
  });

  it('routes every frame-0 command through the adapter', () => {
    expect(adapter.by('spawn')).toHaveLength(EXPECTED_SPAWNS);
    expect(adapter.by('addBody')).toHaveLength(EXPECTED_SPAWNS);
    expect(adapter.by('moveCharacter')).toHaveLength(120);
    expect(adapter.by('applyTransforms')).toHaveLength(120);
  });

  it('packs transforms at stride 12, one row per entity, every frame', () => {
    for (const rows of rowsByFrame) expect(rows).toBe(EXPECTED_SPAWNS);
    // Row 0 is the player: entity id 1, flags position|visible = 1 | 8.
    const first = adapter.by('applyTransforms')[0]?.args[0] as Float32Array;
    expect(first.length % STRIDE).toBe(0);
    expect(first[0]).toBe(1);
    expect(first[1]).toBe(0b1001);
    // Row 1 is the first box: entity 2, flags position|rotation = 1 | 2.
    expect(first[STRIDE]).toBe(2);
    expect(first[STRIDE + 1]).toBe(0b11);
  });

  it('round-trips a synchronous raycast import', () => {
    // Left mouse is down for exactly one frame, so exactly one ray is cast.
    expect(host.rayCalls.raycast).toBe(1);
    expect(tagsByFrame[40]).toContain('play-sound');
    const hud = JSON.parse(hudFrames.at(-1)?.json ?? '{}') as { shots: number; hits: number };
    expect(hud.shots).toBe(1);
    expect(hud.hits).toBe(1);
  });

  it('ingests the stride-15 bodies list', () => {
    const before = JSON.parse(hudFrames[1]?.json ?? '{}') as { bodies: number };
    const after = JSON.parse(hudFrames.at(-1)?.json ?? '{}') as { bodies: number; x: number };
    // Nothing reported before frame 60, one row from frame 60 on.
    expect(before.bodies).toBe(0);
    expect(after.bodies).toBe(1);
    // The host's body row wins over the guest's dead reckoning: the player is
    // pinned near x = 2 rather than wherever 90 frames of W would have put it.
    expect(after.x).toBeGreaterThan(1.8);
    expect(after.x).toBeLessThan(2.2);
  });

  it('resolves manifest names through the assets import', () => {
    // `strictAssets` refuses unknown names, so a typo would show up as a
    // missing play-sound command on the firing frame.
    expect(host.warnings()).toHaveLength(0);
    expect(tagsByFrame[40]).toEqual(['move-character', 'play-sound']);
  });

  it('emits the HUD only when it changes', () => {
    expect(hudFrames.map((h) => h.frame)).toEqual([0, 30, 60, 90]);
    const first = JSON.parse(hudFrames[0]!.json) as { frame: number; shots: number };
    expect(first.frame).toBe(0);
    expect(first.shots).toBe(0);
  });

  it('survives a snapshot and restore round trip', () => {
    const snapshot = sandbox.snapshot();
    // The hand-rolled encoding: 8-byte header, then fixed-width fields.
    expect(snapshot.byteLength).toBe(76);
    expect(new TextDecoder().decode(snapshot.subarray(0, 4))).toBe('AOSR');

    const before = sandbox.tick(harness.createFrameInput({ frame: 120 }));
    const hashBefore = harness.hashFrameOutput(before);

    sandbox.restore(snapshot);
    const after = sandbox.tick(harness.createFrameInput({ frame: 120 }));
    expect(harness.hashFrameOutput(after)).toBe(hashBefore);
    expect(sandbox.dead).toBe(false);
  });

  // Runs last on purpose: `createSandbox` latches `dead` on any throw.
  it('rejects a corrupt snapshot as a typed game-error', () => {
    let thrown: unknown;
    try {
      sandbox.restore(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]));
    } catch (err) {
      thrown = err;
    }
    // `result<_, game-error>` arrives as a jco `ComponentError` whose payload
    // is the WIT record the guest returned — not a trap, and not a string.
    const payload = (thrown as { payload?: { code: string; message: string } }).payload;
    expect(payload?.code).toBe('snapshot-version-mismatch');
    expect(payload?.message).toMatch(/wrong magic/);
    // The sandbox still latches `dead`: that is host policy for a failed
    // lifecycle call, not evidence that the component instance is poisoned.
    expect(sandbox.dead).toBe(true);
  });

  it('reports its timings', () => {
    const pct = (values: number[], q: number): number => {
      const sorted = [...values].sort((a, b) => a - b);
      return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))] ?? 0;
    };
    console.log(
      `rust guest: ${toolchain.cargo} | instantiate ${instantiateMs.toFixed(1)} ms | ` +
        `cold tick p50 ${pct(tickMs, 0.5).toFixed(3)} ms, p99 ${pct(tickMs, 0.99).toFixed(3)} ms | ` +
        `steady tick p50 ${pct(steadyMs, 0.5).toFixed(3)} ms, ` +
        `p90 ${pct(steadyMs, 0.9).toFixed(3)} ms, ` +
        `p99 ${pct(steadyMs, 0.99).toFixed(3)} ms ` +
        `(QuickJS baseline: p50 0.19 ms)`,
    );
    // The QuickJS guest sits at ~0.19 ms p50; a Rust guest has no interpreter
    // in the way at all, so this is a generous ceiling rather than a target.
    expect(pct(steadyMs, 0.5)).toBeLessThan(1);
  });
});
