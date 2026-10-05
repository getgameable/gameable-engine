/**
 * Path helpers.
 *
 * A deliberate, small copy of `gameable/cli`'s equivalents. `npm create
 * gameable` downloads this package and its dependency tree before it prints
 * anything at all, so the scaffolder has **no** runtime dependencies — not even
 * on the engine it is scaffolding.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Forward-slash a path and drop any trailing separator.
 *
 * @param path Any path, in any separator style.
 * @returns The same path with `/` separators and no trailing slash.
 */
export function toPosix(path: string): string {
  const slashed = path.replaceAll('\\', '/');
  if (slashed.length <= 1) return slashed;
  if (/^[A-Za-z]:\/$/.test(slashed)) return slashed;
  return slashed.endsWith('/') ? slashed.slice(0, -1) : slashed;
}

/**
 * Resolve to an absolute, forward-slashed path.
 *
 * @param parts Path segments, resolved left to right against `process.cwd()`.
 * @returns An absolute path with `/` separators.
 */
export function absPosix(...parts: string[]): string {
  return toPosix(resolve(...parts));
}

/**
 * A relative path from one directory to another, for `file:` dependencies.
 *
 * Falls back to the absolute path when the two are on different Windows
 * drives, where no relative path exists.
 *
 * @param fromDir Absolute directory the path is written in.
 * @param toPath Absolute target.
 * @returns A relative path starting with `./` or `../`, or an absolute one.
 */
export function relativeSpecifier(fromDir: string, toPath: string): string {
  const from = toPosix(fromDir).split('/');
  const to = toPosix(toPath).split('/');
  if (from[0] !== to[0]) return toPosix(toPath);
  while (from.length > 0 && to.length > 0 && from[0] === to[0]) {
    from.shift();
    to.shift();
  }
  const joined = [...from.map(() => '..'), ...to].join('/');
  return joined.startsWith('.') ? joined : `./${joined}`;
}

/**
 * The directory of the npm package a module belongs to.
 *
 * @param moduleUrl A module's `import.meta.url`.
 * @returns The absolute, forward-slashed package directory.
 */
export function packageDirOf(moduleUrl: string): string {
  let dir = toPosix(dirname(fileURLToPath(moduleUrl)));
  for (;;) {
    if (existsSync(`${dir}/package.json`)) return dir;
    const parent = toPosix(dirname(dir));
    if (parent === dir) return dir;
    dir = parent;
  }
}

/**
 * Find the gameable monorepo root above `startDir`, if there is one.
 *
 * When the scaffolder is run from inside a checkout of the engine, generated
 * games get `file:` links back at `packages/` instead of published versions.
 *
 * @param startDir Absolute directory to start from.
 * @returns The absolute, forward-slashed repository root, or `undefined`.
 */
export function findRepoRoot(startDir: string): string | undefined {
  let dir = absPosix(startDir);
  for (;;) {
    const manifest = `${dir}/package.json`;
    if (existsSync(manifest) && existsSync(`${dir}/wit`)) {
      try {
        const json = JSON.parse(readFileSync(manifest, 'utf8')) as { workspaces?: unknown };
        const workspaces = json.workspaces;
        if (Array.isArray(workspaces) && workspaces.includes('packages/*')) return dir;
      } catch {
        // An unreadable package.json is simply not the repository root.
      }
    }
    const parent = toPosix(dirname(dir));
    if (parent === dir) return undefined;
    dir = parent;
  }
}
