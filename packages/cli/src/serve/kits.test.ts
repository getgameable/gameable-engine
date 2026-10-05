/**
 * The room server image's games, as `deploy/rooms/Dockerfile` makes them:
 * `scripts/kits.mjs` finds every multiplayer kit, builds its guest and packs
 * it with the bundled `pack.mjs`; `gameable serve --games` then serves them
 * all, and `/health` lists each under its catalog name. The guest builds are
 * mtime-cached, so a warm run is quick; a cold one componentizes every kit.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { catalogName } from '@gameable/net/page';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { bundleServer, PACK_ENTRY } from '../../scripts/bundle-server.mjs';
import { declaresMultiplayer, multiplayerKits, packKits, ROOT } from '../../scripts/kits.mjs';
import { resolveServeOptions } from './options.js';
import { type ServeHandle, startServe } from './startServe.js';

describe('finding the kits', () => {
  it('counts a features.multiplayer declaration, not a comment about one', () => {
    expect(declaresMultiplayer('features: { characters: true, multiplayer: { maxPlayers: 4 } },')).toBe(true);
    expect(declaresMultiplayer('// Add `multiplayer: { maxPlayers: 6 }`\nfeatures: { characters: true },')).toBe(false);
    expect(declaresMultiplayer('/* features: { multiplayer: {} } */ features: {},')).toBe(false);
  });

  it('finds the four kits and leaves the single-player templates out', () => {
    const names = multiplayerKits().map((k) => k.name);
    expect(names).toEqual(expect.arrayContaining(['brawl', 'hangout', 'mystery', 'survive']));
    for (const solo of ['fps', 'third-person', 'visit']) expect(names).not.toContain(solo);
  });

  it("names each one as the page does: catalogName of its package name", () => {
    for (const kit of multiplayerKits()) {
      const pkg = JSON.parse(readFileSync(join(ROOT, kit.dir, 'package.json'), 'utf8')) as { name: string };
      expect(kit.catalog).toBe(catalogName(pkg.name));
    }
  });
});

describe('every kit packed and served (the room server image)', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'aos-kits-'));
  const games = join(scratch, 'games');
  let serve: ServeHandle;

  beforeAll(async () => {
    await bundleServer({ outdir: join(scratch, 'rooms'), entry: PACK_ENTRY, name: 'pack' });
    packKits(games, join(scratch, 'rooms/pack.mjs'));
    serve = await startServe(resolveServeOptions(['--games', games, '--port', '0'], ROOT, {}));
  }, 900_000);

  afterAll(async () => {
    await serve.close();
    rmSync(scratch, { recursive: true, force: true });
  });

  it('writes a guest and a server bundle per kit', () => {
    for (const kit of multiplayerKits()) {
      expect(existsSync(join(games, kit.catalog, 'dist/guest/game.js'))).toBe(true);
      const json = JSON.parse(readFileSync(join(games, kit.catalog, 'dist/server/game.json'), 'utf8')) as { name: string };
      expect(json.name).toBe(kit.catalog);
    }
  });

  it('/health lists every kit', async () => {
    const response = await fetch(`http://127.0.0.1:${String(serve.port)}/health`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { ok: boolean; games: string[] };
    expect(body.ok).toBe(true);
    expect([...body.games].sort()).toEqual(multiplayerKits().map((k) => k.catalog).sort());
  });
});
