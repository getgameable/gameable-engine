import { describe, expect, it } from 'vitest';

import { KEY_WORDS, defineGame, keyIndex, prefab, writeKeyBit } from '@gameable/sdk';
import type { HostApi, InputMods, MouseState, RayHit } from '@gameable/sdk';

import { NullEngineAdapter } from './adapter/EngineAdapter';
import { applyOutput } from './apply';
import { createInputEncoder } from './encode-input';
import { hostBindings } from './host-bindings';
import { createDirectSandbox, createSandbox } from './sandbox';
import { minimalWasi } from './wasi-stubs';

const HIT: RayHit = {
  body: 3,
  entity: 3,
  point: { x: 0, y: 0, z: -4 },
  normal: { x: 0, y: 0, z: 1 },
  distance: 4,
};

/**
 * A host that logs, resolves anything, and always hits.
 *
 * @returns The host plus its recorded log lines.
 */
function makeHost(): { host: HostApi; lines: string[] } {
  const lines: string[] = [];
  const ids = new Map<string, number>();
  let next = 1;
  return {
    lines,
    host: {
      log: (level, msg) => {
        lines.push(`${level}: ${msg}`);
      },
      seed: () => 4242,
      nowMs: () => 0,
      raycast: () => HIT,
      raycastBatch: (rays) => rays.map(() => HIT),
      overlapSphere: () => [],
      resolveId: (name) => {
        let id = ids.get(name);
        if (id === undefined) {
          id = next;
          next += 1;
          ids.set(name, id);
        }
        return id;
      },
      describe: () => undefined,
    },
  };
}

const Target = prefab({
  asset: 'target',
  body: { shape: 'box', dims: [0.5, 0.5, 0.5], kind: 'dynamic', mass: 5 },
});

const game = defineGame({
  assets: ['target'],
  spawns: [{ prefab: Target, position: [0, 1, -4] }],
  systems: [
    (ctx) => {
      if (ctx.input.isDown('W')) ctx.physics.applyImpulse(1, 0, 0, -1);
      ctx.hud.set({ frame: Math.floor(ctx.frame / 30) });
    },
  ],
});

/**
 * The neutral input snapshot the encoder takes.
 *
 * @returns A fresh snapshot.
 */
function snapshot(): {
  down: Uint32Array;
  pressed: Uint32Array;
  released: Uint32Array;
  mods: InputMods;
  mouse: MouseState;
  focused: boolean;
} {
  return {
    down: new Uint32Array(KEY_WORDS),
    pressed: new Uint32Array(KEY_WORDS),
    released: new Uint32Array(KEY_WORDS),
    mods: { shift: false, ctrl: false, alt: false, meta: false, capsLock: false, numLock: false },
    mouse: {
      x: 0,
      y: 0,
      dx: 0,
      dy: 0,
      wheel: 0,
      buttons: 0,
      pressed: 0,
      released: 0,
      locked: true,
    },
    focused: true,
  };
}

describe('createDirectSandbox', () => {
  it('runs a game and applies its output to an adapter', () => {
    const { host } = makeHost();
    const adapter = NullEngineAdapter();
    const sandbox = createDirectSandbox({ mode: 'direct', game, host });
    expect(sandbox.mode).toBe('direct');

    sandbox.init({
      seed: 4242n,
      fixedHz: 60,
      viewportWidth: 800,
      viewportHeight: 600,
      devMode: true,
      options: undefined,
    });

    const encoder = createInputEncoder(64);
    const state = snapshot();
    writeKeyBit(state.down, keyIndex('W'), true);

    for (let frame = 0; frame < 5; frame += 1) {
      const input = encoder.encode({
        frame,
        dt: 1 / 60,
        elapsed: frame / 60,
        inputState: state,
        bodies: new Float32Array(15),
        bodyCount: 0,
      });
      applyOutput(adapter, sandbox.tick(input));
    }

    expect(sandbox.dead).toBe(false);
    expect(adapter.by('spawn')).toHaveLength(1);
    expect(adapter.by('addBody')).toHaveLength(1);
    expect(adapter.by('applyImpulse')).toHaveLength(5);
    expect(adapter.by('applyTransforms')).toHaveLength(5);
    // The HUD only crosses on the frames it changed.
    expect(adapter.by('setHud').filter((c) => c.args[0] !== undefined)).toHaveLength(1);
  });

  it('latches dead on a failing call and returns a safe frame', () => {
    const { host, lines } = makeHost();
    const broken = defineGame({
      init: () => {
        throw new Error('nope');
      },
    });
    const sandbox = createDirectSandbox({ mode: 'direct', game: broken, host });
    expect(() => {
      sandbox.init({
        seed: 1n,
        fixedHz: 60,
        viewportWidth: 1,
        viewportHeight: 1,
        devMode: false,
        options: undefined,
      });
    }).toThrow(/init failed/);
    expect(sandbox.dead).toBe(true);
    expect(sandbox.error?.message).toMatch(/init-failed/);
    expect(lines.some((l) => l.includes('sandbox is dead'))).toBe(true);

    const out = sandbox.tick({
      frame: 0n,
      dt: 1 / 60,
      elapsed: 0,
      input: {
        keys: {
          down: new Uint32Array(KEY_WORDS),
          pressed: new Uint32Array(KEY_WORDS),
          released: new Uint32Array(KEY_WORDS),
        },
        mods: snapshot().mods,
        mouse: snapshot().mouse,
        gamepads: [],
        focused: true,
      },
      bodies: new Float32Array(0),
      contacts: [],
      events: [],
      players: [],
    });
    expect(out.transforms).toHaveLength(12);
    expect(out.commands).toHaveLength(0);
  });
});

describe('createSandbox', () => {
  it('returns a direct sandbox when asked for one', async () => {
    const { host } = makeHost();
    const sandbox = await createSandbox({ mode: 'direct', game, host });
    expect(sandbox.mode).toBe('direct');
  });

  it('refuses a wasm sandbox with neither module nor instantiate', async () => {
    const { host } = makeHost();
    await expect(
      createSandbox({
        mode: 'wasm',
        getCoreModule: () => Promise.reject(new Error('unused')),
        host,
      }),
    ).rejects.toThrow(/guestModuleUrl or instantiate/);
  });

  it('hands the component an unversioned import object', async () => {
    const { host } = makeHost();
    let seenImports: Record<string, unknown> = {};
    const sandbox = await createSandbox({
      mode: 'wasm',
      getCoreModule: () => Promise.reject(new Error('unused')),
      host,
      instantiate: (_getCore, imports) => {
        seenImports = imports;
        return Promise.resolve({
          'gameable:engine/game@0.2.0': {
            init: () => undefined,
            tick: () => ({
              transforms: new Float32Array(12),
              commands: [],
              localCommands: [],
              camera: {
                mode: 'free' as const,
                projection: 'perspective' as const,
                position: { x: 0, y: 0, z: 0 },
                rotation: { x: 0, y: 0, z: 0, w: 1 },
                target: undefined,
                fovYDeg: 60,
                near: 0.1,
                far: 1000,
                follow: undefined,
                armLength: 0,
                offset: { x: 0, y: 0, z: 0 },
              },
              hud: undefined,
            }),
            shutdown: () => undefined,
            snapshot: () => new Uint8Array(0),
            restore: () => undefined,
          },
        });
      },
    });

    expect(sandbox.mode).toBe('wasm');
    expect(Object.keys(seenImports)).toContain('gameable:engine/env');
    expect(Object.keys(seenImports)).toContain('gameable:engine/physics-query');
    expect(Object.keys(seenImports)).toContain('gameable:engine/assets');
    expect(Object.keys(seenImports)).toContain('wasi:clocks/monotonic-clock');
    // Versioned keys would be silently ignored by jco; make sure we emit none.
    expect(Object.keys(seenImports).some((k) => k.includes('@0.'))).toBe(false);
  });
});

describe('hostBindings', () => {
  it('lowers seed to a bigint and option returns to undefined', () => {
    const { host } = makeHost();
    const bindings = hostBindings(host);
    expect(bindings['gameable:engine/env'].seed()).toBe(4242n);
    expect(bindings['gameable:engine/assets'].describe(1)).toBeUndefined();
    expect(bindings['gameable:engine/assets'].resolveId('x')).toBe(1);
    expect(
      bindings['gameable:engine/physics-query'].raycast(
        { x: 0, y: 0, z: 0 },
        { x: 0, y: 0, z: -1 },
        10,
        { layers: {}, solidOnly: true },
      ),
    ).toBe(HIT);
  });
});

describe('minimalWasi', () => {
  it('covers every interface a componentize-qjs guest imports', () => {
    const wasi = minimalWasi();
    // 18 today; `jco transpile` lists exactly these in dist/guest/interfaces.
    expect(Object.keys(wasi)).toHaveLength(18);
    expect(Object.keys(wasi).every((k) => k.startsWith('wasi:'))).toBe(true);
  });

  it('provides a working stderr stream and monotonic clock', () => {
    const written: string[] = [];
    const wasi = minimalWasi({
      stderr: (bytes) => written.push(new TextDecoder().decode(bytes)),
      monotonicNs: () => 7n,
    });
    const stderrFactory = wasi['wasi:cli/stderr'] as { getStderr: () => Record<string, unknown> };
    const stream = stderrFactory.getStderr();
    expect(typeof stream.checkWrite).toBe('function');
    expect(typeof stream.write).toBe('function');
    expect(typeof stream.blockingWrite).toBe('function');
    expect(typeof stream.blockingWriteAndFlush).toBe('function');
    expect(typeof stream.flush).toBe('function');
    expect(typeof stream.blockingFlush).toBe('function');
    expect(typeof stream.subscribe).toBe('function');

    (stream.blockingWriteAndFlush as (b: Uint8Array) => void)(
      new TextEncoder().encode('trap: bang'),
    );
    expect(written).toEqual(['trap: bang']);

    const clock = wasi['wasi:clocks/monotonic-clock'] as { now: () => bigint };
    expect(clock.now()).toBe(7n);
  });

  it('throws loudly for an interface a guest is not expected to need', () => {
    const wasi = minimalWasi();
    const exit = wasi['wasi:cli/exit'] as { exit: () => never };
    expect(() => exit.exit()).toThrow(/not expected to need it/);
  });
});
