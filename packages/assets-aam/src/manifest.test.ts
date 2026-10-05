import { parseManifest } from '@gameable/assets';
import type { AssetEntry } from '@gameable/assets';
import { describe, expect, it } from 'vitest';

import type { AamClient, AamCharacterBundle, AnimationAssetRow } from './client.js';
import { buildCharacterManifestEntries, mergeManifests } from './manifest.js';

/**
 * A client stub that answers the two listings from fixed data.
 *
 * @param bundle Files the `/ogs` listing returns.
 * @param rows Rows the animation-asset listing returns.
 * @returns A client with only the methods the builder uses.
 */
function stubClient(
  bundle: readonly { name: string; url: string }[],
  rows: readonly Partial<AnimationAssetRow>[],
): AamClient {
  const base = 'https://aam.example';
  return {
    baseUrl: base,
    owns: () => true,
    resolveFileUrl: (path) => (path.startsWith('http') ? path : `${base}${path}`),
    request: () => Promise.reject(new Error('not used')),
    listCharacterBundle: () => Promise.resolve({ files: bundle } as unknown as AamCharacterBundle),
    listAnimationAssets: () =>
      Promise.resolve(
        rows.map((r, i) => ({
          id: String(i),
          name: `clip_${String(i)}`,
          kind: 'body',
          additive: false,
          file_url: `/api/character-assets/${String(i)}/clip.glb`,
          updatedAt: null,
          additiveType: 'none',
          basePoseType: 'none',
          basePoseAssetId: null,
          refFrameIndex: 0,
          ...r,
        })) as AnimationAssetRow[],
      ),
    fetchFile: () => Promise.reject(new Error('not used')),
  };
}

/** A bundle listing with one file in it. */
const BUNDLE = [{ name: 'scene.json', url: 'https://aam.example/f/scene.json' }];

describe('buildCharacterManifestEntries', () => {
  it('emits a character entry pointing at a virtual directory', async () => {
    const built = await buildCharacterManifestEntries(stubClient(BUNDLE, []), 'myra');

    expect(built.characterId).toBe('char.myra');
    expect(built.entries).toEqual([
      {
        id: 'char.myra',
        type: 'character',
        src: 'https://aam.example/api/characters/myra/ogs/',
        tags: ['aam', 'myra'],
        rig: { backend: 'orl' },
      },
    ]);
    // The entry survives the engine's own validator, rig rule included.
    expect(
      parseManifest({ version: 1, baseUrl: '/assets/', assets: [...built.entries] }).assets,
    ).toHaveLength(1);
  });

  it('points an exported package at its character.json and gives it the aosrig-splat rig', async () => {
    // What the studio stores (the store keeps the descriptor under its own name).
    const exported = [
      { name: 'character.json', url: 'https://aam.example/f/character.json' },
      { name: 'character-0123456789ab.ply', url: 'https://aam.example/f/character.ply' },
    ];
    const built = await buildCharacterManifestEntries(stubClient(exported, []), 'gm-tala-v1');

    expect(built.entries[0]).toEqual({
      id: 'char.gm-tala-v1',
      type: 'character',
      src: 'https://aam.example/api/characters/gm-tala-v1/ogs/character.json',
      tags: ['aam', 'gm-tala-v1'],
      rig: { backend: 'aosrig-splat' },
    });
    expect(
      parseManifest({ version: 1, baseUrl: '/assets/', assets: [...built.entries] }).assets,
    ).toHaveLength(1);
  });

  it("keeps the folder for a caller's non-aosrig-splat rig, even beside a character.json", async () => {
    const exported = [{ name: 'character.json', url: 'https://aam.example/f/character.json' }];
    const built = await buildCharacterManifestEntries(stubClient(exported, []), 'myra', {
      rig: { backend: 'orl' },
    });

    expect(built.entries[0]?.src).toBe('https://aam.example/api/characters/myra/ogs/');
    expect(built.entries[0]?.rig).toEqual({ backend: 'orl' });
  });

  it('emits one gltf entry per body clip and sanitises the id', async () => {
    const built = await buildCharacterManifestEntries(
      stubClient(BUNDLE, [{ id: '7', name: 'Wave (Right Hand)', additive: true }]),
      'myra',
    );

    expect(built.entries[1]).toEqual({
      id: 'char.myra.wave-right-hand',
      type: 'gltf',
      src: 'https://aam.example/api/character-assets/0/clip.glb',
      tags: ['aam', 'myra', 'clip', 'additive'],
    });
    expect(built.faceClips).toEqual([]);
  });

  it('returns face clips as JSON records, not manifest entries', async () => {
    const built = await buildCharacterManifestEntries(
      stubClient(BUNDLE, [
        { name: 'smile', kind: 'face', file_url: '/api/character-assets/3/smile.json' },
        { name: 'walk', kind: 'body' },
      ]),
      'myra',
    );

    expect(built.entries.map((e) => e.id)).toEqual(['char.myra', 'char.myra.walk']);
    expect(built.faceClips).toEqual([
      {
        id: 'char.myra.smile',
        name: 'smile',
        url: 'https://aam.example/api/character-assets/3/smile.json',
        additive: false,
        additiveType: 'none',
        basePoseType: 'none',
        basePoseAssetId: null,
        refFrameIndex: 0,
        updatedAt: null,
      },
    ]);
  });

  it('honours an id prefix and a custom rig', async () => {
    const built = await buildCharacterManifestEntries(
      stubClient(BUNDLE, [{ name: 'walk' }]),
      'myra',
      {
        idPrefix: 'npc.Guard-01',
        rig: { backend: 'gnm', pack: 'guard.aosrig' },
        tags: ['npc'],
      },
    );

    expect(built.entries.map((e) => e.id)).toEqual(['npc.guard-01', 'npc.guard-01.walk']);
    expect(built.entries[0]?.rig).toEqual({ backend: 'gnm', pack: 'guard.aosrig' });
    expect(built.entries[1]?.tags).toEqual(['npc', 'clip', 'base']);
  });

  it('errors when two clips sanitise to the same id', async () => {
    const client = stubClient(BUNDLE, [{ name: 'Wave!' }, { name: 'wave' }]);
    await expect(buildCharacterManifestEntries(client, 'myra')).rejects.toThrow(
      /collides with an existing id "char\.myra\.wave"/,
    );
  });

  it('errors on an empty bundle rather than 404ing inside the loader', async () => {
    await expect(buildCharacterManifestEntries(stubClient([], []), 'myra')).rejects.toThrow(
      /empty bundle/,
    );
  });

  it('errors on an id prefix that sanitises to nothing', async () => {
    await expect(
      buildCharacterManifestEntries(stubClient(BUNDLE, []), 'myra', { idPrefix: '///' }),
    ).rejects.toThrow(/idPrefix/);
  });
});

describe('mergeManifests', () => {
  /** A base manifest with one local asset. */
  const base = parseManifest({
    version: 1,
    baseUrl: '/assets/',
    assets: [{ id: 'arena', type: 'splat', src: 'arena.spz' }],
  });

  /** One generated entry. */
  const extra: AssetEntry = {
    id: 'char.myra.wave',
    type: 'gltf',
    src: 'https://aam.example/f/wave.glb',
  };

  it('appends entries and keeps the base url', () => {
    const merged = mergeManifests(base, [extra]);
    expect(merged.assets.map((e) => e.id)).toEqual(['arena', 'char.myra.wave']);
    expect(merged.baseUrl).toBe('/assets/');
    expect(base.assets).toHaveLength(1);
  });

  it('accepts another manifest', () => {
    const merged = mergeManifests(base, parseManifest({ version: 1, assets: [extra] }));
    expect(merged.assets).toHaveLength(2);
  });

  it('throws on an id collision instead of letting one definition win', () => {
    expect(() => mergeManifests(base, [{ ...extra, id: 'arena' }])).toThrow(
      /duplicate asset id "arena"/,
    );
  });

  it('throws on a collision between two added entries', () => {
    expect(() => mergeManifests(base, [extra, extra])).toThrow(/duplicate asset id/);
  });

  it('produces a manifest the engine validator still accepts', async () => {
    const built = await buildCharacterManifestEntries(
      stubClient(BUNDLE, [{ name: 'walk' }, { name: 'smile', kind: 'face' }]),
      'myra',
    );
    const merged = mergeManifests(base, built.entries);
    expect(
      parseManifest({ version: 1, baseUrl: merged.baseUrl, assets: [...merged.assets] }).assets,
    ).toHaveLength(3);
  });
});
