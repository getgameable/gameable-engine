import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { mapColliderFiles, type RawManifest } from './manifestFiles.js';
import { colliderFileOf, uniqueColliderFile } from './serverGame.js';

const MYSTERY = fileURLToPath(new URL('../../../../templates/mystery', import.meta.url));
const COLLIDER = '@placeholder/arena.collider.bin';

/**
 * @param baseUrl The manifest's base.
 * @returns A manifest with one static, one trigger and one dynamic collider.
 */
function manifest(baseUrl?: string): RawManifest {
  return {
    version: 1,
    baseUrl,
    assets: [
      { id: 'level', src: 'a.spz', collider: { shape: 'mesh', src: COLLIDER, layer: 'static' } },
      { id: 'zone', src: 'b.glb', collider: { shape: 'mesh', src: COLLIDER, layer: 'trigger' } },
      { id: 'crate', src: 'c.glb', collider: { shape: 'mesh', src: COLLIDER, layer: 'dynamic' } },
      { id: 'floor', src: 'd.glb', collider: { shape: 'mesh', src: COLLIDER } },
    ],
  };
}

describe('mapColliderFiles', () => {
  it('rewrites the static colliders only: those are the ones a room builds', () => {
    const seen: string[] = [];
    const out = mapColliderFiles(manifest('/'), MYSTERY, (entry) => {
      seen.push(entry.id);
      return `colliders/${entry.id}.bin`;
    });
    expect(seen).toEqual(['level', 'floor']); // static, and static by default
    expect(out.assets.map((a) => a.collider?.src)).toEqual(['colliders/level.bin', COLLIDER, COLLIDER, 'colliders/floor.bin']);
  });

  it("refuses a manifest whose baseUrl is not the site root: the page and the server would read different files", () => {
    expect(() => mapColliderFiles(manifest('/models/'), MYSTERY, () => 'x')).toThrow(/baseUrl "\/models\/"/);
    expect(() => mapColliderFiles(manifest(''), MYSTERY, () => 'x')).not.toThrow();
    expect(() => mapColliderFiles(manifest(undefined), MYSTERY, () => 'x')).not.toThrow();
  });
});

describe('uniqueColliderFile', () => {
  it('refuses two ids that map to one file name, instead of overwriting the first', () => {
    const used = new Set<string>();
    expect(uniqueColliderFile('env/arena', used)).toBe(colliderFileOf('env/arena'));
    expect(() => uniqueColliderFile('env_arena', used)).toThrow(/"env_arena" and an earlier entry/);
  });
});
