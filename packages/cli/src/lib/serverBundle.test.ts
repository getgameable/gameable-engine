import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, describe, expect, it } from 'vitest';

import { writeServerBundle } from './serverBundle.js';

const MYSTERY = fileURLToPath(new URL('../../../../templates/mystery', import.meta.url));
const TEMPLATE = fileURLToPath(new URL('../../../../templates/third-person', import.meta.url));
const out = mkdtempSync(join(tmpdir(), 'aos-server-bundle-'));

afterAll(() => {
  rmSync(out, { recursive: true, force: true });
});

describe('writeServerBundle', () => {
  it("writes mystery's game.json from its definition and the page's own physics module", async () => {
    const dist = join(out, 'mystery');
    expect(await writeServerBundle(MYSTERY, { distDir: dist })).toBe(true);
    const json = JSON.parse(readFileSync(join(dist, 'server/game.json'), 'utf8')) as Record<string, unknown>;
    expect(json).toEqual({
      name: 'example-mystery',
      features: { characters: true, multiplayer: { maxPlayers: 6 } },
      world: { gravity: -9.81, maxEntities: 256 },
      physics: { gravity: [0, -9.81, 0] },
      maxPlayers: 6,
      sendHz: 20,
    });
  }, 60_000);

  it("copies the level's collider and points the server manifest at the copy", () => {
    const server = join(out, 'mystery/server');
    const copy = join(server, 'colliders/env.arena.bin');
    expect(existsSync(copy)).toBe(true);
    const original = fileURLToPath(new URL('../../../assets-placeholder/assets/arena.collider.bin', import.meta.url));
    expect(readFileSync(copy).equals(readFileSync(original))).toBe(true);
    const manifest = JSON.parse(readFileSync(join(server, 'assets.json'), 'utf8')) as {
      baseUrl: string;
      assets: { id: string; collider?: { src?: string } }[];
    };
    expect(manifest.baseUrl).toBe('');
    expect(manifest.assets.find((a) => a.id === 'env.arena')?.collider?.src).toBe('colliders/env.arena.bin');
    expect(manifest.assets.map((a) => a.id)).toEqual(['env.arena', 'char.crew', 'sfx.tag']);
  });

  it('writes nothing for a game that does not declare multiplayer', async () => {
    const dist = join(out, 'template');
    expect(await writeServerBundle(TEMPLATE, { distDir: dist })).toBe(false);
    expect(existsSync(join(dist, 'server'))).toBe(false);
  }, 60_000);
});
