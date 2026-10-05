import { describe, expect, it } from 'vitest';

import {
  findEntry,
  joinUrl,
  loadManifest,
  ManifestError,
  parseManifest,
  resolveAssetUrl,
} from './manifest.js';

/**
 * A minimal valid manifest document.
 *
 * @returns A fresh JSON object, safe to mutate in a test.
 */
function doc(): Record<string, unknown> {
  return {
    version: 1,
    baseUrl: '/assets/',
    assets: [
      { id: 'arena', type: 'splat', src: 'arena.spz', tags: ['world'] },
      { id: 'shot', type: 'audio', src: 'sfx/shot.ogg', tags: ['sfx'] },
    ],
  };
}

describe('parseManifest', () => {
  it('accepts the schema example verbatim', () => {
    const manifest = parseManifest({
      version: 1,
      baseUrl: '/assets/',
      assets: [
        {
          id: 'arena',
          type: 'splat',
          src: 'arena.spz',
          tags: ['world'],
          collider: { shape: 'mesh', src: 'arena.collider.glb', layer: 'static' },
        },
        { id: 'shot', type: 'audio', src: 'sfx/shot.ogg', tags: ['sfx'] },
        {
          id: 'npc-myra',
          type: 'character',
          src: 'characters/myra/scene.json',
          rig: {
            backend: 'gnm',
            pack: 'characters/myra/gnm_head.aosrig',
            vertexCount: 17821,
            expressionSpace: { kind: 'gnm', dim: 387 },
          },
        },
      ],
    });
    expect(manifest.assets).toHaveLength(3);
    expect(manifest.assets[2].rig!.backend).toBe('gnm');
    expect(manifest.version).toBe(1);
  });

  it('defaults baseUrl to the empty string and honours the option fallback', () => {
    expect(parseManifest({ version: 1, assets: [] }).baseUrl).toBe('');
    expect(parseManifest({ version: 1, assets: [] }, { baseUrl: '/x/' }).baseUrl).toBe('/x/');
  });

  it('prefers the declared baseUrl over the fallback', () => {
    expect(parseManifest(doc(), { baseUrl: '/ignored/' }).baseUrl).toBe('/assets/');
  });

  it('freezes the result', () => {
    const manifest = parseManifest(doc());
    expect(Object.isFrozen(manifest)).toBe(true);
    expect(Object.isFrozen(manifest.assets)).toBe(true);
    expect(Object.isFrozen(manifest.assets[0])).toBe(true);
  });

  it.each([
    [null, '$'],
    [[], '$'],
    ['nope', '$'],
    [{ version: 2, assets: [] }, '$.version'],
    [{ assets: [] }, '$.version'],
    [{ version: 1 }, '$.assets'],
    [{ version: 1, assets: {} }, '$.assets'],
    [{ version: 1, assets: [], extra: 1 }, '$.extra'],
    [{ version: 1, baseUrl: 3, assets: [] }, '$.baseUrl'],
  ])('rejects %j at %s', (json, path) => {
    expect(() => parseManifest(json)).toThrow(ManifestError);
    try {
      parseManifest(json);
    } catch (err) {
      expect((err as ManifestError).path).toBe(path);
    }
  });

  it.each([
    [{ id: 'Arena', type: 'splat', src: 'a.spz' }, 'assets[0].id'],
    [{ id: 'a b', type: 'splat', src: 'a.spz' }, 'assets[0].id'],
    [{ id: 'a', type: 'model', src: 'a.spz' }, 'assets[0].type'],
    [{ id: 'a', type: 'splat' }, 'assets[0].src'],
    [{ id: 'a', type: 'splat', src: '' }, 'assets[0].src'],
    [{ id: 'a', type: 'splat', src: 'a.spz', nope: 1 }, 'assets[0].nope'],
    [{ id: 'a', type: 'character', src: 'a.json' }, 'assets[0].rig'],
    [{ id: 'a', type: 'audio', src: 'a.ogg', rig: { backend: 'orl' } }, 'assets[0].rig'],
    [{ id: 'a', type: 'splat', src: 'a.spz', tags: ['x', 'x'] }, 'assets[0].tags[1]'],
    [
      { id: 'a', type: 'gltf', src: 'a.glb', collider: { shape: 'box' } },
      'assets[0].collider.halfExtents',
    ],
    [
      { id: 'a', type: 'gltf', src: 'a.glb', collider: { shape: 'sphere' } },
      'assets[0].collider.radius',
    ],
    [
      { id: 'a', type: 'gltf', src: 'a.glb', collider: { shape: 'capsule', radius: 1 } },
      'assets[0].collider.height',
    ],
    [
      { id: 'a', type: 'gltf', src: 'a.glb', collider: { shape: 'sphere', radius: 0 } },
      'assets[0].collider.radius',
    ],
    [{ id: 'a', type: 'character', src: 'a.json', rig: { backend: 'gnm' } }, 'assets[0].rig.pack'],
    [
      { id: 'a', type: 'character', src: 'a.json', rig: { backend: 'zzz' } },
      'assets[0].rig.backend',
    ],
    [
      {
        id: 'a',
        type: 'character',
        src: 'a.json',
        rig: { backend: 'orl', expressionSpace: { kind: 'arkit52', dim: 0 } },
      },
      'assets[0].rig.expressionSpace.dim',
    ],
  ])('rejects entry %j at %s', (entry, path) => {
    try {
      parseManifest({ version: 1, assets: [entry] });
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ManifestError);
      expect((err as ManifestError).path).toBe(path);
    }
  });

  it('accepts a skinned character with no pack', () => {
    const manifest = parseManifest({
      version: 1,
      assets: [
        { id: 'char.hero', type: 'character', src: 'aosrig_v0.glb', rig: { backend: 'skinned' } },
      ],
    });
    expect(manifest.assets[0].rig!.backend).toBe('skinned');
    expect(manifest.assets[0].rig!.pack).toBeUndefined();
  });

  it('still requires a pack for the gnm backend', () => {
    expect(() =>
      parseManifest({
        version: 1,
        assets: [{ id: 'a', type: 'character', src: 'a.json', rig: { backend: 'gnm' } }],
      }),
    ).toThrow(/is required when backend is "gnm"/);
  });

  it('names every backend when one is unknown', () => {
    expect(() =>
      parseManifest({
        version: 1,
        assets: [{ id: 'a', type: 'character', src: 'a.json', rig: { backend: 'zzz' } }],
      }),
    ).toThrow(/orl, gnm, skinned/);
  });

  it('rejects duplicate ids', () => {
    const json = {
      version: 1,
      assets: [
        { id: 'a', type: 'gltf', src: 'a.glb' },
        { id: 'a', type: 'gltf', src: 'b.glb' },
      ],
    };
    expect(() => parseManifest(json)).toThrow(/duplicate id "a"/);
  });

  it('accepts a box collider with half extents and an offset', () => {
    const manifest = parseManifest({
      version: 1,
      assets: [
        {
          id: 'crate',
          type: 'gltf',
          src: 'crate.glb',
          collider: { shape: 'box', halfExtents: [1, 2, 3], offset: [0, 1, 0], layer: 'dynamic' },
        },
      ],
    });
    expect(manifest.assets[0].collider!.halfExtents).toEqual([1, 2, 3]);
    expect(manifest.assets[0].collider!.layer).toBe('dynamic');
  });

  it('accepts expression-space segments', () => {
    const manifest = parseManifest({
      version: 1,
      assets: [
        {
          id: 'myra',
          type: 'character',
          src: 'myra/scene.json',
          rig: {
            backend: 'orl',
            controlNames: ['jaw', 'brow'],
            vertexCount: 10,
            expressionSpace: {
              kind: 'gnm68',
              dim: 68,
              segments: [{ name: 'left_eye', offset: 0, length: 34 }],
            },
          },
        },
      ],
    });
    expect(manifest.assets[0].rig!.expressionSpace!.segments![0].name).toBe('left_eye');
  });
});

describe('findEntry', () => {
  it('finds by id and returns undefined otherwise', () => {
    const manifest = parseManifest(doc());
    expect(findEntry(manifest, 'shot')?.src).toBe('sfx/shot.ogg');
    expect(findEntry(manifest, 'missing')).toBeUndefined();
  });
});

describe('joinUrl', () => {
  it.each([
    ['', 'a.glb', 'a.glb'],
    ['/assets/', 'a.glb', '/assets/a.glb'],
    ['/assets', 'a.glb', '/assets/a.glb'],
    ['/assets/', 'sfx/a.ogg', '/assets/sfx/a.ogg'],
    ['/assets/', '/root.glb', '/root.glb'],
    ['/assets/', 'https://cdn.example/a.glb', 'https://cdn.example/a.glb'],
    [
      '/assets/',
      'data:application/octet-stream;base64,AA==',
      'data:application/octet-stream;base64,AA==',
    ],
    ['/assets/', '//cdn.example/a.glb', '//cdn.example/a.glb'],
    ['https://cdn.example/a/b/', 'c.glb', 'https://cdn.example/a/b/c.glb'],
    ['https://cdn.example/a/b', 'c.glb', 'https://cdn.example/a/b/c.glb'],
    ['https://cdn.example/a/b/', '../c.glb', 'https://cdn.example/a/c.glb'],
    ['https://cdn.example/a/b/', '/c.glb', '/c.glb'],
  ])('joins %s + %s', (base, src, expected) => {
    expect(joinUrl(base, src)).toBe(expected);
  });
});

describe('resolveAssetUrl', () => {
  it('resolves by entry and by id', () => {
    const manifest = parseManifest(doc());
    expect(resolveAssetUrl(manifest, 'arena')).toBe('/assets/arena.spz');
    expect(resolveAssetUrl(manifest, manifest.assets[1])).toBe('/assets/sfx/shot.ogg');
  });

  it('throws for an unknown id', () => {
    expect(() => resolveAssetUrl(parseManifest(doc()), 'nope')).toThrow(ManifestError);
  });
});

describe('loadManifest', () => {
  it('defaults baseUrl to the manifest directory', async () => {
    const fakeFetch = (() =>
      Promise.resolve(
        new Response(
          JSON.stringify({ version: 1, assets: [{ id: 'a', type: 'gltf', src: 'a.glb' }] }),
          {
            status: 200,
          },
        ),
      )) as unknown as typeof globalThis.fetch;

    const manifest = await loadManifest('/content/pack/assets.json?v=2', { fetch: fakeFetch });
    expect(manifest.baseUrl).toBe('/content/pack/');
    expect(resolveAssetUrl(manifest, 'a')).toBe('/content/pack/a.glb');
  });

  it('reports a failed fetch', async () => {
    const fakeFetch = (() =>
      Promise.resolve(new Response('nope', { status: 404 }))) as unknown as typeof globalThis.fetch;
    await expect(loadManifest('/missing.json', { fetch: fakeFetch })).rejects.toThrow(/404/);
  });
});

describe('findEntry: per-manifest memo', () => {
  it('indexes a manifest once and keeps the index keyed on its identity', () => {
    const json = {
      version: 1,
      assets: [
        { id: 'a', type: 'audio', src: 'a.ogg' },
        { id: 'b', type: 'audio', src: 'b.ogg' },
      ],
    };
    const first = parseManifest(json);
    const second = parseManifest(json);

    // Two parses of the same JSON are two manifests, each with its own entries
    // and its own index; nothing is shared between them by accident.
    expect(findEntry(first, 'b')).toBe(first.assets[1]);
    expect(findEntry(second, 'b')).toBe(second.assets[1]);
    expect(findEntry(first, 'b')).not.toBe(findEntry(second, 'b'));

    // The memo is exact because `parseManifest` freezes what it returns: the
    // entry list behind an index can never change.
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.assets)).toBe(true);
    expect(findEntry(first, 'missing')).toBeUndefined();
    expect(findEntry(first, 'a')).toBe(findEntry(first, 'a'));
  });
});
