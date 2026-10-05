#!/usr/bin/env node
/**
 * Build the tiny-game guest component.
 *
 * Three steps, every path absolute and forward-slashed because Windows paths
 * break shell-string pipelines:
 *
 * 1. **generate the entry.** `jco componentize` compiles exactly one module,
 *    and that module has to import the versioned `gameable:engine/*@0.2.0`
 *    specifiers. So the build writes a four-line `build/entry.ts` that pulls
 *    in the SDK's entry factory and the game's default export. One generated
 *    entry per game; the game itself never mentions WIT.
 * 2. **componentize.** `jco componentize --backend qjs
 *    --backend-qjs-disable-async`. TypeScript is bundled automatically by
 *    rolldown, so `build/entry.ts`, the SDK sources and bitecs all come along.
 *    Red `UNRESOLVED_IMPORT` warnings for the `gameable:engine/*` specifiers are
 *    expected: componentize resolves them itself, after the bundle.
 *    A generated `--bundle-config` aliases `gameable` onto the SDK
 *    sources, because rolldown runs with `platform: "neutral"` and therefore
 *    never applies the workspace's `development` export condition.
 * 3. **transpile.** `jco transpile --instantiation async --no-nodejs-compat`
 *    emits nine core wasm files plus `game.js`, whose `instantiate` the host
 *    calls with the import object. There is no `--map`.
 *
 * `buildTinyGame({ game: 'twoSeats' })` builds another module of
 * `src/` (here `src/twoSeats.ts`) into `build/twoSeats/`, for tests that need
 * the same game with a different declaration.
 *
 * Usage:
 *   node scripts/build.mjs             build when stale
 *   node scripts/build.mjs --force     always rebuild
 *   node scripts/build.mjs --quiet     only report on failure
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Absolute, forward-slashed path to `fixtures/tiny-game`. */
export const FIXTURE = fileURLToPath(new URL('../', import.meta.url))
  .replaceAll('\\', '/')
  .replace(/\/$/, '');
/** Absolute, forward-slashed repository root. */
export const ROOT = FIXTURE.slice(0, FIXTURE.lastIndexOf('/fixtures/'));
/** Where every build artefact lands. Gitignored. */
export const BUILD = `${FIXTURE}/build`;
/** The transpiled guest the host imports. */
export const GUEST_DIR = `${BUILD}/guest`;
/** The module with the `instantiate` export. */
export const GUEST_ENTRY = `${GUEST_DIR}/game.js`;
/** The authored WIT package. */
const WIT = `${ROOT}/wit`;
/** jco's entry point, from the repository's own install. */
const JCO = `${ROOT}/node_modules/@bytecodealliance/jco/dist/jco.js`;
/** The SDK entry factory, imported by the generated entry. */
const SDK_ENTRY = `${ROOT}/packages/sdk/src/wit/entry.ts`;

/**
 * Where one game module of the fixture builds to.
 *
 * @param {string} game A module of `src/`, without `.ts`; `game` is the fixture itself.
 * @returns {{ build: string, guestDir: string, guestEntry: string, wasm: string, source: string }} Its paths.
 */
function pathsFor(game) {
  const build = game === 'game' ? BUILD : `${BUILD}/${game}`;
  const guestDir = `${build}/guest`;
  return {
    build,
    guestDir,
    guestEntry: `${guestDir}/game.js`,
    wasm: `${build}/game.wasm`,
    source: `${FIXTURE}/src/${game}.ts`,
  };
}

/** Everything whose mtime decides whether the build is stale. */
const SOURCE_DIRS = [`${FIXTURE}/src`, `${ROOT}/packages/sdk/src`, WIT];
const SOURCE_FILES = [`${FIXTURE}/scripts/build.mjs`];

/**
 * Newest mtime under a path, recursively.
 *
 * @param {string} path Absolute file or directory.
 * @returns {number} Milliseconds since the epoch, or 0 when absent.
 */
function newest(path) {
  if (!existsSync(path)) return 0;
  const stat = statSync(path);
  if (!stat.isDirectory()) return stat.mtimeMs;
  let max = stat.mtimeMs;
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'build') continue;
    max = Math.max(max, newest(join(path, entry.name).replaceAll('\\', '/')));
  }
  return max;
}

/**
 * Run jco, throwing with its output on failure.
 *
 * @param {string[]} args jco arguments.
 * @param {boolean} quiet Suppress stdout on success.
 * @returns {void}
 */
function jco(args, quiet) {
  const result = spawnSync(process.execPath, [JCO, ...args], {
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0) {
    process.stderr.write(result.stdout ?? '');
    process.stderr.write(result.stderr ?? '');
    throw new Error(`jco ${args[0]} failed with status ${String(result.status)}`);
  }
  if (!quiet) process.stdout.write(result.stdout ?? '');
}

/**
 * The generated componentize entry.
 *
 * Relative specifiers, not absolute ones: rolldown resolves them from the
 * generated file's own directory, and relative paths keep working when the
 * repository moves. Extensions are omitted because rolldown resolves
 * `./x` to `./x.ts` and TypeScript would reject an explicit `.ts`.
 *
 * @param {{ build: string, source: string }} at Where the entry goes, and the game module.
 * @returns {string} The entry source.
 */
function entrySource(at) {
  const sdk = relativeFrom(at.build, SDK_ENTRY).replace(/\.ts$/, '');
  const game = relativeFrom(at.build, at.source).replace(/\.ts$/, '');
  return [
    '// GENERATED by fixtures/tiny-game/scripts/build.mjs — do not edit.',
    '//',
    '// One of these is generated per game. It is the only file that knows',
    '// about WIT: the SDK entry factory adapts the versioned gameable:engine',
    '// imports, and the game module supplies the definition.',
    `import { createGuestExports } from '${sdk}';`,
    `import definition from '${game}';`,
    '',
    'export const game = createGuestExports(definition);',
    '',
  ].join('\n');
}

/**
 * The generated rolldown configuration.
 *
 * `jco componentize` bundles with `platform: "neutral"`, so the workspace's
 * `development` export condition never applies and `gameable` would
 * resolve to `dist/`, which may not be built. Aliasing straight onto the SDK
 * sources keeps the wasm guest and the direct guest byte-identical in origin
 * as well as in behaviour.
 *
 * @returns {string} The config module source.
 */
function bundleConfigSource() {
  const sdk = `${ROOT}/packages/sdk/src`;
  return [
    '// GENERATED by fixtures/tiny-game/scripts/build.mjs — do not edit.',
    '// rolldown takes `resolve.alias` as a plain record, not the Vite array',
    '// form; longer keys are listed first so subpaths win over the bare name.',
    'export default {',
    '  resolve: {',
    '    alias: {',
    `      'gameable/sdk/keycodes': '${sdk}/keycodes.ts',`,
    `      'gameable/sdk/prelude': '${sdk}/prelude.ts',`,
    `      'gameable': '${sdk}/index.ts',`,
    '    },',
    '  },',
    '};',
    '',
  ].join('\n');
}

/**
 * Forward-slashed relative path from one absolute directory to another.
 *
 * @param {string} fromDir Absolute directory.
 * @param {string} toPath Absolute file.
 * @returns {string} A specifier starting with `./` or `../`.
 */
function relativeFrom(fromDir, toPath) {
  const from = fromDir.split('/');
  const to = toPath.split('/');
  while (from.length > 0 && to.length > 0 && from[0] === to[0]) {
    from.shift();
    to.shift();
  }
  const up = from.map(() => '..');
  const parts = [...up, ...to];
  const joined = parts.join('/');
  return joined.startsWith('.') ? joined : `./${joined}`;
}

/**
 * Build the guest if anything changed.
 *
 * @param {{ force?: boolean, quiet?: boolean, game?: string }} options Build options;
 *   `game` names the module of `src/` to build (default `game`).
 * @returns {{ built: boolean, guestEntry: string, guestDir: string }} What happened.
 */
export function buildTinyGame(options = {}) {
  const quiet = options.quiet ?? false;
  const at = pathsFor(options.game ?? 'game');
  const label =
    options.game === undefined || options.game === 'game'
      ? 'tiny-game'
      : `tiny-game/${options.game}`;
  const builtAt = newest(at.guestEntry);
  let sourceAt = 0;
  for (const dir of [...SOURCE_DIRS, ...SOURCE_FILES]) sourceAt = Math.max(sourceAt, newest(dir));

  if (!options.force && builtAt > 0 && builtAt >= sourceAt) {
    if (!quiet) console.log(`${label}: up to date`);
    return { built: false, guestEntry: at.guestEntry, guestDir: at.guestDir };
  }

  mkdirSync(at.build, { recursive: true });
  const entryPath = `${at.build}/entry.ts`;
  const source = entrySource(at);
  if (!existsSync(entryPath) || readFileSync(entryPath, 'utf8') !== source) {
    writeFileSync(entryPath, source, 'utf8');
  }

  const bundleConfigPath = `${at.build}/rolldown.config.mjs`;
  const bundleConfig = bundleConfigSource();
  if (!existsSync(bundleConfigPath) || readFileSync(bundleConfigPath, 'utf8') !== bundleConfig) {
    writeFileSync(bundleConfigPath, bundleConfig, 'utf8');
  }

  if (!quiet) console.log(`${label}: componentize`);
  jco(
    [
      'componentize',
      '--backend',
      'qjs',
      '--backend-qjs-disable-async',
      '-n',
      'game-module',
      '--wit',
      WIT,
      '--bundle-config',
      bundleConfigPath,
      '-o',
      at.wasm,
      entryPath,
    ],
    quiet,
  );

  if (!quiet) console.log(`${label}: transpile`);
  jco(
    [
      'transpile',
      at.wasm,
      '--instantiation',
      'async',
      '--no-nodejs-compat',
      '--name',
      'game',
      '-o',
      at.guestDir,
      '--quiet',
    ],
    quiet,
  );

  if (!quiet) {
    const bytes = statSync(at.wasm).size;
    console.log(`${label}: built ${(bytes / 1024 / 1024).toFixed(2)} MiB component`);
  }
  return { built: true, guestEntry: at.guestEntry, guestDir: at.guestDir };
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  process.argv[1].replaceAll('\\', '/').endsWith('fixtures/tiny-game/scripts/build.mjs');

if (invokedDirectly) {
  buildTinyGame({
    force: process.argv.includes('--force'),
    quiet: process.argv.includes('--quiet'),
  });
}
