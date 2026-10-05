/**
 * `gameable/assets/node` — manifest sources as files on disk, for Node
 * hosts (`gameable serve`, `gameable build`'s server bundle). The browser
 * gets the same files through the bundler's `?url` imports instead.
 */
import { createRequire } from 'node:module';
import { join } from 'node:path';

/** `src` prefixes for files shipped inside a package, and the package folder each names. */
const PACKAGED: readonly (readonly [prefix: string, folder: string])[] = [
  ['@placeholder/', '@gameable/assets-placeholder/assets/'],
  ['@aosrig/', '@gameable/assets-aosrig/assets/'],
];

/** `https:`, `data:`, `file:`...: a src that is already a URL. */
const URL_SCHEME = /^[a-z][a-z0-9+.-]*:/i;

/**
 * The file a manifest `src` names, for a game in `gameDir`:
 *
 * - `@placeholder/<file>` and `@aosrig/<file>` are files inside the installed
 *   `gameable/placeholder` and `gameable/aosrig` packages,
 *   found from the game's own `node_modules`;
 * - anything else is a path the page serves from the game's `public/` folder
 *   (`/models/hero.glb` is `<gameDir>/public/models/hero.glb`).
 *
 * @param src The manifest `src` (an entry's or a collider's).
 * @param gameDir The game's directory, holding its `package.json`.
 * @returns The absolute file path.
 * @throws {Error} When a packaged file is not installed, or `src` is a URL.
 *
 * @example
 * ```ts
 * import { resolvePackagedAssetPath } from 'gameable/assets/node';
 *
 * resolvePackagedAssetPath('@placeholder/arena.collider.bin', process.cwd());
 * // '<game>/node_modules/gameable/assets/arena.collider.bin'
 * ```
 */
export function resolvePackagedAssetPath(src: string, gameDir: string): string {
  for (const [prefix, folder] of PACKAGED) {
    if (!src.startsWith(prefix)) continue;
    const require = createRequire(join(gameDir, 'package.json'));
    try {
      return require.resolve(`${folder}${src.slice(prefix.length)}`);
    } catch (cause) {
      throw new Error(`"${src}" is not installed: no ${folder}${src.slice(prefix.length)} from ${gameDir}`, {
        cause,
      });
    }
  }
  if (src.startsWith('//') || URL_SCHEME.test(src)) {
    throw new Error(`"${src}" is a URL, not a file of the game`);
  }
  return join(gameDir, 'public', src.replace(/^\/+/, ''));
}
