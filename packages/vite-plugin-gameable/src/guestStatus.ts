/**
 * The dev server's answer to "is the built guest stale?".
 *
 * A multiplayer game's Play Solo runs its authority as the game built to
 * wasm (`build/guest/`), even under `npm run dev`, while the page's own client
 * guest runs the TypeScript as it is now. When the build is older than the
 * sources the two run different rules, silently. The page asks
 * {@link GUEST_STATUS_PATH} and warns (`gameable/net/solo`'s `startPlaySolo`).
 */
import { existsSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

import type { DevMiddleware } from './plugin';

/**
 * Where the dev server answers whether the built guest is stale. The same
 * path is `GUEST_STATUS_PATH` in `gameable/net/solo`, which asks it.
 *
 * @example
 * ```ts
 * import { GUEST_STATUS_PATH } from 'gameable/vite';
 *
 * console.log(GUEST_STATUS_PATH); // '/__aos/guest-status.json'
 * ```
 */
export const GUEST_STATUS_PATH = '/__aos/guest-status.json';

/**
 * The answer at {@link GUEST_STATUS_PATH}.
 *
 * @example
 * ```ts
 * import type { GuestStatus } from 'gameable/vite';
 *
 * const status: GuestStatus = { builtAt: 0, sourceAt: 1, stale: true };
 * ```
 */
export interface GuestStatus {
  /** The built guest's mtime in ms, or 0 when there is none. */
  builtAt: number;
  /** The newest mtime among the sources it is built from. */
  sourceAt: number;
  /** No guest, or a source newer than it. */
  stale: boolean;
}

/**
 * Newest mtime under a path, recursively, skipping `node_modules` and `build`.
 *
 * @param path Absolute file or directory.
 * @returns Milliseconds since the epoch, or 0 when absent.
 */
function newest(path: string): number {
  if (!existsSync(path)) return 0;
  const stat = statSync(path);
  if (!stat.isDirectory()) return stat.mtimeMs;
  let max = stat.mtimeMs;
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'build') continue;
    max = Math.max(max, newest(join(path, entry.name)));
  }
  return max;
}

/**
 * Whether the built guest is older than what it is built from.
 *
 * @param paths The guest's entry and the sources.
 * @param paths.guestEntry The transpiled guest's `game.js` (`build/guest/game.js`).
 * @param paths.sources Files and directories it is built from.
 * @returns The newest mtimes, and stale when there is no guest or a source is newer.
 *
 * @example
 * ```ts
 * import { guestFreshness, guestSources } from 'gameable/vite';
 *
 * const status = guestFreshness({ guestEntry: 'build/guest/game.js', sources: guestSources('.') });
 * if (status.stale) console.warn('run npm run build:guest');
 * ```
 */
export function guestFreshness(paths: {
  guestEntry: string;
  sources: readonly string[];
}): GuestStatus {
  const builtAt = newest(paths.guestEntry);
  let sourceAt = 0;
  for (const path of paths.sources) sourceAt = Math.max(sourceAt, newest(path));
  return { builtAt, sourceAt, stale: builtAt === 0 || builtAt < sourceAt };
}

/**
 * What a game's guest is built from: its `src/`, its `scripts/build-guest.mjs`,
 * and the SDK's sources when they are installed beside it (in this
 * repository's workspace).
 *
 * @param root The app root (Vite's `root`).
 * @returns Absolute paths; missing ones count as never changed.
 *
 * @example
 * ```ts
 * import { guestSources } from 'gameable/vite';
 *
 * console.log(guestSources('/app')); // ['/app/src', '/app/scripts/build-guest.mjs', ...]
 * ```
 */
export function guestSources(root: string): string[] {
  const sources = [join(root, 'src'), join(root, 'scripts', 'build-guest.mjs')];
  try {
    const pkg = realpathSync(
      dirname(createRequire(join(root, 'package.json')).resolve('gameable/package.json')),
    );
    // In the engine repository the guest is built from the SDK workspace's
    // sources; an installed `gameable` only changes when it is reinstalled.
    const workspaceSdk = join(pkg, '..', 'sdk', 'src');
    sources.push(existsSync(workspaceSdk) ? workspaceSdk : join(pkg, 'dist'));
  } catch {
    // No SDK resolvable from here: the app's own files are all there is to check.
  }
  return sources;
}

/**
 * @param paths The guest entry and the sources, read on every request.
 * @returns The dev middleware that answers {@link GUEST_STATUS_PATH}.
 */
export function guestStatusMiddleware(
  paths: () => { guestEntry: string; sources: readonly string[] },
): DevMiddleware {
  return (req, res, next) => {
    if ((req.url ?? '').split('?')[0] !== GUEST_STATUS_PATH) {
      next();
      return;
    }
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'no-store');
    res.end(JSON.stringify(guestFreshness(paths())));
  };
}
