/**
 * The dev server's stale-guest answer (`guestFreshness` over real files with
 * set mtimes, and the middleware that serves it), and the guest a direct
 * build ships for Play Solo.
 */
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { GUEST_STATUS_PATH, guestFreshness, guestSources } from './guestStatus';
import { gameable, type DevMiddleware } from './plugin';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/**
 * @param guestAt The built guest's mtime in seconds, or null for no guest.
 * @param sourceAt `src/game.ts`'s mtime in seconds.
 * @returns An app root: `src/game.ts` and maybe `build/guest/game.js`.
 */
function app(guestAt: number | null, sourceAt: number): string {
  const root = mkdtempSync(join(tmpdir(), 'aos-guest-'));
  dirs.push(root);
  const src = join(root, 'src');
  mkdirSync(src);
  const game = join(src, 'game.ts');
  writeFileSync(game, 'export {};');
  utimesSync(game, sourceAt, sourceAt);
  utimesSync(src, sourceAt, sourceAt);
  if (guestAt !== null) {
    const guest = join(root, 'build', 'guest');
    mkdirSync(guest, { recursive: true });
    writeFileSync(join(guest, 'game.js'), '');
    utimesSync(join(guest, 'game.js'), guestAt, guestAt);
  }
  return root;
}

/**
 * @param root The app root.
 * @returns What the dev server answers at `GUEST_STATUS_PATH`, or null when it passed the request on.
 */
function ask(root: string): { headers: Record<string, string>; body: unknown } | null {
  const plugin = gameable();
  plugin.configResolved?.({ root, base: '/' });
  const middlewares: DevMiddleware[] = [];
  plugin.configureServer?.({ middlewares: { use: (fn) => middlewares.push(fn) } });
  const headers: Record<string, string> = {};
  let body: unknown;
  let passed = 0;
  for (const middleware of middlewares) {
    middleware(
      { url: GUEST_STATUS_PATH },
      { setHeader: (n, v) => (headers[n] = v), statusCode: 200, end: (chunk) => (body = chunk) },
      () => (passed += 1),
    );
    if (body !== undefined) break;
  }
  return passed === middlewares.length ? null : { headers, body: JSON.parse(String(body)) };
}

describe('guestFreshness', () => {
  it('is stale when a source is newer than the built guest, fresh when not', () => {
    const paths = (root: string) => ({
      guestEntry: join(root, 'build/guest/game.js'),
      sources: [join(root, 'src')],
    });
    expect(guestFreshness(paths(app(1_000, 2_000))).stale).toBe(true);
    expect(guestFreshness(paths(app(3_000, 2_000))).stale).toBe(false);
  });

  it('is stale when there is no built guest', () => {
    const root = app(null, 2_000);
    const status = guestFreshness({ guestEntry: join(root, 'x.js'), sources: [root] });
    expect(status).toMatchObject({ builtAt: 0, stale: true });
  });

  it("reads the app's src/ and its build script by default", () => {
    const sources = guestSources('/app').map((path) => path.replaceAll('\\', '/'));
    expect(sources.slice(0, 2)).toEqual(['/app/src', '/app/scripts/build-guest.mjs']);
  });
});

describe('the dev server answers whether the guest is stale', () => {
  it('at GUEST_STATUS_PATH, uncached, from disk on every request', () => {
    const root = app(1_000, 2_000);
    const stale = ask(root);
    expect(stale?.headers['Cache-Control']).toBe('no-store');
    expect(stale?.body).toMatchObject({ stale: true });
    utimesSync(join(root, 'build/guest/game.js'), 3_000, 3_000);
    expect(ask(root)?.body).toMatchObject({ stale: false });
  });
});

describe('a direct build of a multiplayer game', () => {
  it('ships the built guest, because Play Solo runs it in every mode', () => {
    const root = app(3_000, 2_000);
    const plugin = gameable({ mode: 'direct' });
    plugin.configResolved?.({ root, base: '/' });
    const emitted: string[] = [];
    plugin.generateBundle?.call({ emitFile: (a) => emitted.push(a.fileName), warn: () => 0 });
    expect(emitted).toEqual(['guest/game.js']);
  });

  it('says plainly when there is no guest to ship', () => {
    const plugin = gameable({ mode: 'direct' });
    plugin.configResolved?.({ root: app(null, 2_000), base: '/' });
    const warnings: string[] = [];
    plugin.generateBundle?.call({ emitFile: () => 0, warn: (m) => warnings.push(m) });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/Play Solo.*npm run build:guest/s);
  });
});
