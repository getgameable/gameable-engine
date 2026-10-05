import { describe, expect, it } from 'vitest';

import type { EngineContext } from '@gameable/core';

import { audio } from './module';
import type { AudioModule } from './module';
import {
  asAudioContext,
  createFakeAudioBuffer,
  createFakeAudioContext,
} from './testing/fakeAudioContext';
import type { FakeAudioContext } from './testing/fakeAudioContext';

/**
 * A module wired to a fake context and a fake gesture target.
 *
 * @param loaded Asset id/handle to loaded object, as the asset registry would report it.
 * @param idOf Handle-to-id resolver, as the real asset registry has one. Left
 *   out, the fake registry has none, which is the `#`-key fallback path.
 * @returns The fake context, the gesture target, the engine context and the module.
 */
function setup(
  loaded: ReadonlyMap<string | number, unknown> = new Map(),
  idOf?: (handle: number) => string | undefined,
): {
  fake: FakeAudioContext;
  target: EventTarget;
  ctx: EngineContext;
  mod: AudioModule;
} {
  const fake = createFakeAudioContext();
  const target = new EventTarget();
  // The audio module reads only `ctx.assets`, so the rest of the host surface
  // (scene, camera, renderer, events, clock) is not built here.
  const ctx = {
    assets: {
      get: (idOrHandle: string | number): unknown => loaded.get(idOrHandle),
      ...(idOf ? { idOf } : {}),
    },
  } as unknown as EngineContext;
  const mod = audio({ context: asAudioContext(fake), unlockTarget: target });
  return { fake, target, ctx, mod };
}

describe('audio module', () => {
  it('identifies itself and has no engine before init', () => {
    const { fake, ctx, mod } = setup();

    expect(mod.id).toBe('audio');
    expect(mod.order).toBe(30);
    // The engine — and the `AudioContext` behind it — is built by `init`, not
    // by `audio()`.
    expect(mod.service).toBeNull();

    // The registry publishes whatever init returns under the module id.
    const engine = mod.init(ctx);
    expect(engine).toBe(mod.service);
    expect(engine.context as unknown).toBe(fake);
    expect(engine.buses.master as unknown).toBe(fake.gains[0]);
  });

  it('touches no AudioContext constructor until init', () => {
    const globals = globalThis as { AudioContext?: unknown };
    const saved = globals.AudioContext;
    let built = 0;
    globals.AudioContext = function fail(): never {
      built += 1;
      throw new Error('no AudioContext should be constructed here');
    };
    try {
      const mod = audio();
      expect(built).toBe(0);
      expect(mod.service).toBeNull();
      // Disposing a module that was never initialised is a no-op, not a
      // reason to build a context just to close it.
      expect(() => {
        mod.dispose();
      }).not.toThrow();
      expect(built).toBe(0);
    } finally {
      if (saved === undefined) delete globals.AudioContext;
      else globals.AudioContext = saved;
    }
  });

  it('honours an explicit order', () => {
    const fake = createFakeAudioContext();
    const mod = audio({ context: asAudioContext(fake), order: 5 });

    expect(mod.order).toBe(5);
    mod.dispose();
  });

  it('update pumps the engine', () => {
    const { fake, ctx, mod } = setup();
    const engine = mod.init(ctx);

    engine.play({ id: 1, buffer: createFakeAudioBuffer(0.5) });
    fake.currentTime += 0.25;
    mod.update(0.25, 0);
    expect(engine.ended).toEqual([]);

    fake.currentTime += 0.3;
    mod.update(0.3, 0);
    expect(engine.ended).toEqual([1]);
  });

  it('update and dispose before init do nothing', () => {
    const { mod } = setup();
    expect(() => {
      mod.update(1 / 60, 0);
      mod.dispose();
    }).not.toThrow();
    expect(mod.service).toBeNull();
  });
});

describe('audio module: user-gesture unlock', () => {
  it('resumes on the first pointerdown and then unhooks itself', () => {
    const { fake, target, ctx, mod } = setup();
    mod.init(ctx);

    expect(fake.resumeCount).toBe(0);

    target.dispatchEvent(new Event('pointerdown'));
    expect(fake.resumeCount).toBe(1);
    expect(fake.state).toBe('running');

    target.dispatchEvent(new Event('pointerdown'));
    target.dispatchEvent(new Event('keydown'));
    expect(fake.resumeCount).toBe(1);
  });

  it('resumes on the first keydown too', () => {
    const { fake, target, ctx, mod } = setup();
    mod.init(ctx);

    target.dispatchEvent(new Event('keydown'));
    expect(fake.resumeCount).toBe(1);
  });

  it('dispose removes a listener that never fired and tears the graph down', () => {
    const { fake, target, ctx, mod } = setup();
    mod.init(ctx);
    mod.dispose();

    target.dispatchEvent(new Event('pointerdown'));
    expect(fake.resumeCount).toBe(0);
    expect(fake.gains[0].outputs).toEqual([]);
  });
});

describe('audio module: decodeAsset', () => {
  it('decodes the bytes behind a handle, once per handle', async () => {
    const { fake, ctx, mod } = setup(new Map([[42, new ArrayBuffer(16)]]));
    mod.init(ctx);

    const buffer = await mod.decodeAsset(42);
    expect(buffer.duration).toBe(1);

    await mod.decodeAsset(42);
    expect(fake.decodeCalls).toHaveLength(1);
  });

  it('accepts a manifest id as well as a handle', async () => {
    const { fake, ctx, mod } = setup(
      new Map<string | number, unknown>([
        ['pistol', new ArrayBuffer(16)],
        [42, new ArrayBuffer(16)],
      ]),
    );
    mod.init(ctx);

    await mod.decodeAsset('pistol');
    await mod.decodeAsset(42);

    // Ids and handles are separate cache keys, so '42' cannot collide with 42.
    expect(fake.decodeCalls).toHaveLength(2);
  });

  it('resolves a handle to its id, so both share one decode', async () => {
    const { fake, ctx, mod } = setup(
      new Map<string | number, unknown>([
        ['sfx.shot', new ArrayBuffer(16)],
        [7, new ArrayBuffer(16)],
      ]),
      (handle) => (handle === 7 ? 'sfx.shot' : undefined),
    );
    mod.init(ctx);

    const byId = await mod.decodeAsset('sfx.shot');
    const byHandle = await mod.decodeAsset(7);

    expect(byHandle).toBe(byId);
    expect(fake.decodeCalls).toHaveLength(1);
  });

  it('decodedAsset answers synchronously once a decode has settled', async () => {
    const { ctx, mod } = setup(
      new Map<string | number, unknown>([['sfx.shot', new ArrayBuffer(16)]]),
      (handle) => (handle === 7 ? 'sfx.shot' : undefined),
    );

    // Nothing is decoded before init, and nothing is decoded before the first
    // `decodeAsset` for that id.
    expect(mod.decodedAsset('sfx.shot')).toBeUndefined();
    mod.init(ctx);
    expect(mod.decodedAsset('sfx.shot')).toBeUndefined();

    const pending = mod.decodeAsset('sfx.shot');
    expect(mod.decodedAsset('sfx.shot')).toBeUndefined();

    const buffer = await pending;
    expect(mod.decodedAsset('sfx.shot')).toBe(buffer);
    // The handle normalises to the same id, so it hits the same entry.
    expect(mod.decodedAsset(7)).toBe(buffer);
    expect(mod.decodedAsset('sfx.miss')).toBeUndefined();

    mod.dispose();
    expect(mod.decodedAsset('sfx.shot')).toBeUndefined();
  });

  it('rejects before init, for a missing asset, and for a non-audio asset', async () => {
    const { ctx, mod } = setup(new Map<string | number, unknown>([['arena', { scene: {} }]]));

    await expect(mod.decodeAsset(42)).rejects.toThrow('before init');

    mod.init(ctx);
    await expect(mod.decodeAsset(42)).rejects.toThrow('not a loaded audio buffer');
    await expect(mod.decodeAsset('arena')).rejects.toThrow('not a loaded audio buffer');
  });
});
