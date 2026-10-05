import { describe, expect, it, vi } from 'vitest';

import { parseManifest } from './manifest.js';
import type { AssetProgress } from './registry.js';
import { AssetError, createAssetRegistry } from './registry.js';

/**
 * A three-entry manifest used by most tests here.
 *
 * @returns The parsed manifest.
 */
function manifest() {
  return parseManifest({
    version: 1,
    baseUrl: '/assets/',
    assets: [
      { id: 'arena', type: 'splat', src: 'arena.spz', tags: ['world', 'big'] },
      { id: 'shot', type: 'audio', src: 'sfx/shot.ogg', tags: ['sfx'] },
      { id: 'rock', type: 'gltf', src: 'rock.glb', tags: ['world'] },
    ],
  });
}

describe('handles', () => {
  it('assigns stable 1-based handles in manifest order', () => {
    const assets = createAssetRegistry({ manifest: manifest() });
    expect(assets.resolve('arena')).toBe(1);
    expect(assets.resolve('shot')).toBe(2);
    expect(assets.resolve('rock')).toBe(3);
  });

  it('resolves an unknown id to 0', () => {
    const assets = createAssetRegistry({ manifest: manifest() });
    expect(assets.resolve('nope')).toBe(0);
    expect(assets.idOf(0)).toBeUndefined();
    expect(assets.idOf(99)).toBeUndefined();
  });

  it('round-trips id -> handle -> id', () => {
    const assets = createAssetRegistry({ manifest: manifest() });
    for (const id of assets.ids) expect(assets.idOf(assets.resolve(id))).toBe(id);
  });

  it('looks entries and urls up by id or handle', () => {
    const assets = createAssetRegistry({ manifest: manifest() });
    expect(assets.entry('shot')?.type).toBe('audio');
    expect(assets.entry(2)?.id).toBe('shot');
    expect(assets.url('shot')).toBe('/assets/sfx/shot.ogg');
    expect(assets.url(1)).toBe('/assets/arena.spz');
    expect(assets.url('nope')).toBeUndefined();
  });

  it('gives the same entry object for an id, its handle and the manifest', () => {
    const parsed = manifest();
    const assets = createAssetRegistry({ manifest: parsed });

    // The handle indexes the manifest array directly, so there is exactly one
    // entry object per asset and no copy anywhere.
    expect(assets.entry(2)).toBe(assets.entry('shot'));
    expect(assets.entry(2)).toBe(parsed.assets[1]);
    expect(assets.entry('shot')).toBe(assets.entry('shot'));
  });

  it('returns a stable, precomputed url string per handle', () => {
    const assets = createAssetRegistry({ manifest: manifest() });
    const first = assets.url(2);
    expect(assets.url(2)).toBe(first);
    expect(assets.url('shot')).toBe(first);
  });

  it('rejects an out-of-range handle rather than an entry from nowhere', () => {
    const assets = createAssetRegistry({ manifest: manifest() });
    expect(assets.entry(0)).toBeUndefined();
    expect(assets.entry(4)).toBeUndefined();
    expect(assets.url(4)).toBeUndefined();
    expect(assets.get(4)).toBeUndefined();
  });
});

describe('load: memoisation', () => {
  it('hands back one promise per loaded id instead of a fresh one per call', async () => {
    const assets = createAssetRegistry({
      manifest: manifest(),
      loaders: { gltf: async () => Promise.resolve({ ok: true }) },
    });

    const loading = assets.load('rock');
    // While it is in flight, every caller shares the in-flight promise.
    expect(assets.load('rock')).toBe(loading);
    await loading;

    // Once it has resolved, they share the resolved one — including through
    // the handle, which normalises to the same id.
    const hit = assets.load('rock');
    expect(assets.load('rock')).toBe(hit);
    expect(assets.load(3)).toBe(hit);
  });

  it('shares one rejection per unknown id and still retries a failed load', async () => {
    let calls = 0;
    const assets = createAssetRegistry({
      manifest: manifest(),
      loaders: {
        gltf: async () => {
          calls += 1;
          return calls === 1 ? Promise.reject(new Error('boom')) : Promise.resolve({ ok: true });
        },
      },
    });

    const first = assets.load('nope');
    expect(assets.load('nope')).toBe(first);
    await expect(first).rejects.toBeInstanceOf(AssetError);
    // A different unknown name gets its own error.
    await expect(assets.load('also-nope')).rejects.toThrow(/also-nope/);

    // A load that fails is not memoised: the next call really retries.
    await expect(assets.load('rock')).rejects.toThrow(/failed to load/);
    await expect(assets.load('rock')).resolves.toEqual({ ok: true });
    expect(calls).toBe(2);
  });
});

describe('load', () => {
  it('calls the loader with the resolved url and caches the result', async () => {
    const loader = vi.fn(async (url: string) => Promise.resolve({ url }));
    const assets = createAssetRegistry({ manifest: manifest(), loaders: { gltf: loader } });

    const first = await assets.load('rock');
    const second = await assets.load('rock');

    expect(first).toEqual({ url: '/assets/rock.glb' });
    expect(second).toBe(first);
    expect(loader).toHaveBeenCalledTimes(1);
    expect(assets.get('rock')).toBe(first);
    expect(assets.get(3)).toBe(first);
  });

  it('de-duplicates concurrent loads', async () => {
    let resolveIt: ((v: string) => void) | undefined;
    const loader = vi.fn(
      async () =>
        new Promise<string>((res) => {
          resolveIt = res;
        }),
    );
    const assets = createAssetRegistry({ manifest: manifest(), loaders: { gltf: loader } });

    const a = assets.load('rock');
    const b = assets.load('rock');
    expect(loader).toHaveBeenCalledTimes(1);
    resolveIt!('ok');
    expect(await a).toBe('ok');
    expect(await b).toBe('ok');
  });

  it('rejects unknown ids', async () => {
    const assets = createAssetRegistry({ manifest: manifest() });
    await expect(assets.load('nope')).rejects.toBeInstanceOf(AssetError);
    await expect(assets.load('nope')).rejects.toThrow(/add it to assets.json/);
  });

  it('rejects types with no registered loader, naming registerLoader', async () => {
    const assets = createAssetRegistry({ manifest: manifest() });
    await expect(assets.load('arena')).rejects.toThrow(/registerLoader\('splat'/);
  });

  it('wraps loader failures and stays retryable', async () => {
    const loader = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce('ok');
    const assets = createAssetRegistry({ manifest: manifest(), loaders: { gltf: loader } });

    await expect(assets.load('rock')).rejects.toBeInstanceOf(AssetError);
    expect(await assets.load('rock')).toBe('ok');
    expect(loader).toHaveBeenCalledTimes(2);
  });

  it('is unset after dispose', async () => {
    const loader = vi.fn(async () => Promise.resolve('ok'));
    const assets = createAssetRegistry({ manifest: manifest(), loaders: { gltf: loader } });
    await assets.load('rock');
    assets.dispose();
    expect(assets.get('rock')).toBeUndefined();
    await assets.load('rock');
    expect(loader).toHaveBeenCalledTimes(2);
  });

  it('passes the abort signal through to the loader', async () => {
    const controller = new AbortController();
    const loader = vi.fn(async (_url: string, _entry: unknown, ctx: { signal?: AbortSignal }) =>
      Promise.resolve(ctx.signal),
    );
    const assets = createAssetRegistry({
      manifest: manifest(),
      loaders: { gltf: loader },
      signal: controller.signal,
    });
    expect(await assets.load('rock')).toBe(controller.signal);
  });
});

describe('registerLoader', () => {
  it('lets a package add its own type later', async () => {
    const assets = createAssetRegistry({ manifest: manifest() });
    expect(assets.hasLoader('splat')).toBe(false);
    assets.registerLoader('splat', async (url) => Promise.resolve(`splat:${url}`));
    expect(assets.hasLoader('splat')).toBe(true);
    expect(await assets.load('arena')).toBe('splat:/assets/arena.spz');
  });
});

describe('preload', () => {
  it('loads everything and reports progress', async () => {
    const loader = async (url: string) => Promise.resolve(url);
    const assets = createAssetRegistry({
      manifest: manifest(),
      loaders: { gltf: loader, audio: loader, splat: loader },
    });
    const seen: AssetProgress[] = [];
    assets.onProgress((p) => seen.push(p));

    await assets.preload();

    expect(seen).toHaveLength(3);
    expect(seen.at(-1)).toMatchObject({ loaded: 3, total: 3, ok: true });
    expect(assets.get('arena')).toBe('/assets/arena.spz');
  });

  it('filters by tag', async () => {
    const loader = vi.fn(async (url: string) => Promise.resolve(url));
    const assets = createAssetRegistry({
      manifest: manifest(),
      loaders: { gltf: loader, audio: loader, splat: loader },
    });
    await assets.preload('world');
    expect(loader).toHaveBeenCalledTimes(2);
    expect(assets.get('shot')).toBeUndefined();
  });

  it('aggregates failures and still reports every entry', async () => {
    const assets = createAssetRegistry({
      manifest: manifest(),
      loaders: {
        gltf: async () => Promise.reject(new Error('bad glb')),
        audio: async (url) => Promise.resolve(url),
        splat: async (url) => Promise.resolve(url),
      },
    });
    const seen: AssetProgress[] = [];
    assets.onProgress((p) => seen.push(p));

    await expect(assets.preload()).rejects.toBeInstanceOf(AggregateError);
    expect(seen).toHaveLength(3);
    expect(seen.filter((p) => !p.ok)).toHaveLength(1);
  });

  it('stops reporting after unsubscribe', async () => {
    const assets = createAssetRegistry({
      manifest: manifest(),
      loaders: { gltf: async (url) => Promise.resolve(url) },
    });
    const cb = vi.fn();
    const off = assets.onProgress(cb);
    off();
    await assets.preload('big').catch(() => undefined);
    await assets.preload().catch(() => undefined);
    expect(cb).not.toHaveBeenCalled();
  });
});
