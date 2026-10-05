/**
 * `gameable serve --games <dir>`: two built games (wasm guests and server
 * bundles) from one host, as the container serves them: the production path.
 * It builds the two guests (componentize, mtime-cached) and still runs in the
 * default `npm test`, which CI runs: about 13 s cold and 8 s warm on a laptop
 * (3.11a fix round), and no gate would otherwise run built mode at all.
 */
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { TestPlayer } from '@gameable/rooms/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { writeServerBundle } from '../lib/serverBundle.js';
import { resolveServeOptions } from './options.js';
import { type ServeHandle, startServe } from './startServe.js';

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const MYSTERY = join(ROOT, 'templates/mystery');
const ORIGIN = { origin: 'http://localhost:5192' };

/**
 * @param check Polled until true.
 * @param what What is awaited, for the timeout message.
 * @param ms Give up after this long.
 */
async function until(check: () => boolean, what: string, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

/** @returns A games folder: mystery as `gameable build` leaves it, and the tiny fixture. */
async function gamesFolder(): Promise<string> {
  const games = mkdtempSync(join(tmpdir(), 'aos-games-'));
  const mystery = (await import(pathHref('templates/mystery/scripts/build-guest.mjs'))) as {
    buildGuest(o: object): { guestDir: string };
  };
  const tiny = (await import(pathHref('fixtures/tiny-game/scripts/build.mjs'))) as {
    buildTinyGame(o: object): { guestDir: string };
  };
  cpSync(mystery.buildGuest({ quiet: true }).guestDir, join(games, 'mystery/dist/guest'), { recursive: true });
  await writeServerBundle(MYSTERY, { distDir: join(games, 'mystery/dist') });
  cpSync(tiny.buildTinyGame({ quiet: true }).guestDir, join(games, 'tiny/dist/guest'), { recursive: true });
  // The fixture has no Vite to read it through, so its game.json is written by hand.
  mkdirSync(join(games, 'tiny/dist/server'), { recursive: true });
  const json = { name: 'tiny', features: { multiplayer: { maxPlayers: 2 } }, world: {}, physics: { gravity: [0, 0, 0] }, maxPlayers: 2, sendHz: 20 };
  writeFileSync(join(games, 'tiny/dist/server/game.json'), JSON.stringify(json));
  return games;
}

/**
 * @param rel A path under the repository root.
 * @returns Its file URL.
 */
function pathHref(rel: string): string {
  return pathToFileURL(join(ROOT, rel)).href;
}

describe('gameable serve --games (built)', () => {
  let games: string;
  let serve: ServeHandle;
  let endpoint: string;

  beforeAll(async () => {
    games = await gamesFolder();
    serve = await startServe(resolveServeOptions(['--games', games, '--port', '0'], ROOT, {}));
    endpoint = `ws://127.0.0.1:${String(serve.port)}`;
  }, 300_000);

  afterAll(async () => {
    await serve.close();
    rmSync(games, { recursive: true, force: true });
  });

  it('serves both games under their game.json names', () => {
    expect(serve.names).toEqual(['example-mystery', 'tiny']);
  });

  it('two players join mystery by code, see each other, and stand on the arena', async () => {
    const a = await TestPlayer.create(endpoint, 'example-mystery', { name: 'A' }, ORIGIN);
    const b = await TestPlayer.joinById(endpoint, a.room.roomId, { name: 'B', game: a.room.name }, ORIGIN);
    try {
      await until(() => a.replica.welcomes > 0 && b.replica.welcomes > 0, 'both welcomes');
      await until(
        () => a.replica.entities.has(b.replica.entity) && b.replica.entities.has(a.replica.entity),
        "each other's entity",
      );
      await new Promise((r) => setTimeout(r, 1000)); // one second: about 5 m of falling, with no floor
      // Standing: the capsule's centre is its half height (0.8 + 0.35) above the floor, and stays there.
      // Rows are sent only for what moved, so a player at rest has its welcome or last row here.
      expect(a.replica.seen(a.replica.entity)[1]).toBeCloseTo(1.15, 1);
      expect(a.replica.seen(b.replica.entity)[1]).toBeCloseTo(1.15, 1);
      expect(b.replica.seen(a.replica.entity)[1]).toBeCloseTo(1.15, 1);
    } finally {
      await b.leave();
      await a.leave();
    }
  }, 60_000);

  it('the second game takes players too', async () => {
    const t = await TestPlayer.create(endpoint, 'tiny', { name: 'T' }, ORIGIN);
    try {
      await until(() => t.replica.welcomes > 0, 'the welcome');
      expect((t.replica.snapshot as { entities: unknown[] }).entities.length).toBeGreaterThan(0);
    } finally {
      await t.leave();
    }
  }, 30_000);
});
