/**
 * Path helpers. Every path the CLI hands to another process is **absolute and
 * forward-slashed**, because Windows backslashes break jco, rolldown and every
 * shell-string pipeline in between.
 *
 * Nothing here touches the filesystem except {@link findUp},
 * {@link findRepoRoot} and {@link resolveFrom}, so the normalisation is unit
 * testable with no fixtures at all.
 */
import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Forward-slash a path and drop any trailing separator.
 *
 * A bare drive root keeps its slash: `C:\` becomes `C:/`, not `C:`.
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
 * True when `path` is already absolute.
 *
 * @param path Any path.
 * @returns Whether the path needs no base to be meaningful.
 */
export function isAbsolutePath(path: string): boolean {
  return isAbsolute(path) || /^[A-Za-z]:[\\/]/.test(path) || path.startsWith('//');
}

/**
 * A relative ESM specifier from one directory to one file.
 *
 * Both arguments must already be absolute and forward-slashed. The result
 * always starts with `./` or `../`, so rolldown treats it as a path and not as
 * a bare package name.
 *
 * @param fromDir Absolute directory the specifier is written in.
 * @param toPath Absolute file the specifier points at.
 * @returns A relative, forward-slashed specifier.
 */
export function relativeSpecifier(fromDir: string, toPath: string): string {
  const from = toPosix(fromDir).split('/');
  const to = toPosix(toPath).split('/');
  // Different Windows drives share no root, and `../../F:/...` is nonsense.
  // rolldown resolves an absolute specifier perfectly well, so use one.
  if (from[0] !== to[0]) return toPosix(toPath);
  while (from.length > 0 && to.length > 0 && from[0] === to[0]) {
    from.shift();
    to.shift();
  }
  const joined = [...from.map(() => '..'), ...to].join('/');
  return joined.startsWith('.') ? joined : `./${joined}`;
}

/**
 * Walk up from `startDir` looking for a relative path that exists.
 *
 * @param startDir Absolute directory to start from.
 * @param relativeTarget Path to test in each ancestor, for example `wit`.
 * @returns The absolute, forward-slashed match, or `undefined`.
 */
export function findUp(startDir: string, relativeTarget: string): string | undefined {
  let dir = absPosix(startDir);
  for (;;) {
    const candidate = `${dir}/${relativeTarget}`;
    if (existsSync(candidate)) return candidate;
    const parent = toPosix(dirname(dir));
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/**
 * Find the gameable monorepo root above `startDir`, if there is one.
 *
 * The marker is a `package.json` whose `workspaces` include `packages/*`
 * together with a sibling `wit/` directory. That is deliberately narrow: a
 * generated game must never accidentally decide it is the engine repository.
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

/**
 * The directory of the npm package a module belongs to.
 *
 * Works from `src/` under vitest and from `dist/` after a `tsdown` build, which
 * is why nothing in this package hard-codes a relative depth.
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
 * Resolve a package specifier as if from inside `fromDir`.
 *
 * @param fromDir Absolute directory whose `node_modules` chain applies.
 * @param specifier A bare specifier, for example `@bytecodealliance/jco/package.json`.
 * @returns The absolute, forward-slashed file, or `undefined` when unresolvable.
 */
export function resolveFrom(fromDir: string, specifier: string): string | undefined {
  try {
    const require = createRequire(`${absPosix(fromDir)}/package.json`);
    return toPosix(require.resolve(specifier));
  } catch {
    return undefined;
  }
}

/**
 * Resolve a package's own directory as if from inside `fromDir`.
 *
 * The `node_modules` chain is walked directly rather than going through
 * `require.resolve('<name>/package.json')`, because a package with an `exports`
 * map that does not list `./package.json` — `@bytecodealliance/jco`, for one —
 * makes the resolver throw even though the package is plainly installed. The
 * resolver is still the fallback, for layouts that are not plain `node_modules`.
 *
 * @param fromDir Absolute directory whose `node_modules` chain applies.
 * @param name Package name, for example `gameable`.
 * @returns The absolute, forward-slashed package directory, or `undefined`.
 */
export function resolvePackageDir(fromDir: string, name: string): string | undefined {
  let dir = absPosix(fromDir);
  for (;;) {
    const candidate = `${dir}/node_modules/${name}`;
    if (existsSync(`${candidate}/package.json`)) return candidate;
    const parent = toPosix(dirname(dir));
    if (parent === dir) break;
    dir = parent;
  }
  const manifest = resolveFrom(fromDir, `${name}/package.json`);
  return manifest === undefined ? undefined : toPosix(dirname(manifest));
}

/**
 * Resolve one known file inside an installed package.
 *
 * @param fromDir Absolute directory whose `node_modules` chain applies.
 * @param name Package name, for example `vite`.
 * @param relativePath File inside the package, for example `bin/vite.js`.
 * @returns The absolute, forward-slashed file, or `undefined` when absent.
 */
export function resolvePackageFile(
  fromDir: string,
  name: string,
  relativePath: string,
): string | undefined {
  const dir = resolvePackageDir(fromDir, name);
  if (dir === undefined) return undefined;
  const file = `${dir}/${relativePath}`;
  return existsSync(file) ? file : undefined;
}
