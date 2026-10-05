/**
 * The build script's own staleness check: `guestFreshness` over real files
 * with set mtimes decides whether `npm run build:guest` rebuilds. The dev
 * server's stale-guest answer and the page's warning are
 * `gameable/vite`'s and `gameable/net/solo`'s.
 */
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { guestFreshness } from '../scripts/build-guest.mjs';

const dirs: string[] = [];

/**
 * @param guestAt The guest entry's mtime in seconds, or null for no guest.
 * @param sourceAt A source file's mtime in seconds.
 * @returns The paths `guestFreshness` reads.
 */
function layout(
  guestAt: number | null,
  sourceAt: number,
): { guestEntry: string; sources: string[] } {
  const dir = mkdtempSync(join(tmpdir(), 'mystery-guest-'));
  dirs.push(dir);
  const src = join(dir, 'src');
  mkdirSync(src);
  const game = join(src, 'game.ts');
  writeFileSync(game, 'export {};');
  utimesSync(game, sourceAt, sourceAt);
  utimesSync(src, sourceAt, sourceAt);
  const guestEntry = join(dir, 'game.js');
  if (guestAt !== null) {
    writeFileSync(guestEntry, '');
    utimesSync(guestEntry, guestAt, guestAt);
  }
  return { guestEntry, sources: [src] };
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('the build script: is the guest stale?', () => {
  it('is stale when a source is newer than the built guest, fresh when not', () => {
    expect(guestFreshness(layout(1_000, 2_000)).stale).toBe(true);
    expect(guestFreshness(layout(3_000, 2_000)).stale).toBe(false);
  });

  it('is stale when there is no built guest', () => {
    const status = guestFreshness(layout(null, 2_000));
    expect(status).toMatchObject({ builtAt: 0, stale: true });
  });
});
