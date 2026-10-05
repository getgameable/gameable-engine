#!/usr/bin/env node
/**
 * Build the game's WebAssembly component.
 *
 * `npm run dev` never needs this: direct mode runs `src/game.ts` as-is.
 * `npm run build` runs it, because the shipping path is a component.
 *
 * Three steps, every path absolute and forward-slashed, because Windows paths
 * break shell-string pipelines:
 *
 * 1. **generate the entry.** `jco componentize` compiles exactly one module,
 *    and that module has to import the versioned `gameable:engine/*@0.2.0`
 *    specifiers. So this writes a four-line `build/entry.ts` that pulls in the
 *    SDK's entry factory and `src/game.ts`'s default export. The game itself
 *    never mentions WIT.
 * 2. **componentize.** `jco componentize --backend qjs
 *    --backend-qjs-disable-async`. TypeScript is bundled by rolldown, so the
 *    entry, the SDK sources and bitecs all come along. Red `UNRESOLVED_IMPORT`
 *    warnings for `gameable:engine/*` are expected — componentize resolves those
 *    itself, after the bundle. A generated `--bundle-config` aliases
 *    `gameable` onto the SDK sources, because rolldown runs with
 *    `platform: "neutral"` and so never applies the `gameable-source` condition.
 * 3. **transpile.** `jco transpile --instantiation async --no-nodejs-compat`
 *    emits the core wasm files plus `game.js`, whose `instantiate` the host
 *    calls with the import object. `gameable/vite` copies the
 *    whole directory into `dist/guest/`.
 *
 * Usage:
 *   node scripts/build-guest.mjs           build when stale
 *   node scripts/build-guest.mjs --force   always rebuild
 *   node scripts/build-guest.mjs --quiet   only report on failure
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);

/**
 * Absolute, forward-slashed path.
 *
 * @param {string} path Any path.
 * @returns {string} The same path with forward slashes and no trailing one.
 */
function slash(path) {
  return path.replaceAll('\\', '/').replace(/\/$/, '');
}

/** The game root: the directory holding `package.json`. */
export const ROOT = slash(fileURLToPath(new URL('../', import.meta.url)));
/** Where every build artefact lands. Gitignored. */
export const BUILD = `${ROOT}/build`;
/** The transpiled guest the host imports; the Vite plugin serves this directory. */
export const GUEST_DIR = `${BUILD}/guest`;
/** The module with the `instantiate` export. */
export const GUEST_ENTRY = `${GUEST_DIR}/game.js`;
/** The component, between step 2 and step 3. */
const WASM = `${BUILD}/game.wasm`;
/** The game module whose default export is the definition. */
const GAME = `${ROOT}/src/game.ts`;

/** jco's CLI entry, from wherever the install put it. */
const JCO = slash(join(dirname(require.resolve('@bytecodealliance/jco')), 'jco.js'));
/** The `gameable` package's own directory: its build and its WIT package. */
const GAMEABLE_DIR = slash(dirname(require.resolve('gameable/package.json')));
/** The SDK workspace beside it, when the game sits in the engine repository. */
const SDK_DIR = slash(join(GAMEABLE_DIR, '..', 'sdk'));
/** The SDK sources, aliased into the bundle. */
const SDK_SRC = `${SDK_DIR}/src`;
/** Use the same source runtime as the game aliases; mixing dist and src duplicates SDK state. */
const SDK_ENTRY = `${SDK_SRC}/wit/entry.ts`;

/**
 * Locate the authored `gameable:engine` WIT package.
 *
 * Inside the engine repository it is `<repo>/wit`. In an installed app it
 * ships beside the SDK. `GAMEABLE_WIT_DIR` overrides both.
 *
 * @returns {string} Absolute, forward-slashed path to the WIT directory.
 */
function findWit() {
  const candidates = [
    process.env.GAMEABLE_WIT_DIR,
    `${ROOT}/wit`,
    `${GAMEABLE_DIR}/wit`,
    // The workspace layout: packages/sdk -> packages -> repo root.
    slash(join(SDK_DIR, '..', '..', 'wit')),
  ].filter((path) => typeof path === 'string' && path.length > 0);
  for (const candidate of candidates) {
    if (existsSync(join(candidate, 'world.wit'))) return slash(candidate);
  }
  throw new Error(
    `cannot find the gameable:engine WIT package. Looked in:\n  ${candidates.join('\n  ')}\n` +
      'Set GAMEABLE_WIT_DIR to the directory holding world.wit.',
  );
}

/** Everything whose mtime decides whether the build is stale. */
const SOURCE_DIRS = [`${ROOT}/src`, SDK_SRC];
const SOURCE_FILES = [`${ROOT}/scripts/build-guest.mjs`];

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
    max = Math.max(max, newest(slash(join(path, entry.name))));
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
  const joined = [...from.map(() => '..'), ...to].join('/');
  return joined.startsWith('.') ? joined : `./${joined}`;
}

/**
 * The generated componentize entry.
 *
 * Relative specifiers, not absolute ones: rolldown resolves them from the
 * generated file's own directory, and relative paths keep working when the
 * project moves. Extensions are omitted because rolldown resolves `./x` to
 * `./x.ts` and TypeScript would reject an explicit `.ts`.
 *
 * @returns {string} The entry source.
 */
function entrySource() {
  const sdk = relativeFrom(BUILD, SDK_ENTRY).replace(/\.ts$/, '');
  const game = relativeFrom(BUILD, GAME).replace(/\.ts$/, '');
  return [
    '// GENERATED by scripts/build-guest.mjs — do not edit.',
    '//',
    '// The only file in this project that knows about WIT: the SDK entry',
    "// factory adapts the versioned gameable:engine imports, and src/game.ts's",
    '// default export supplies the definition.',
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
 * `jco componentize` bundles with `platform: "neutral"`, so the `gameable-source`
 * export condition never applies and `gameable` would resolve to
 * `dist/`, which may not be built. Aliasing straight onto the SDK sources
 * keeps the wasm guest and the direct guest identical in origin as well as in
 * behaviour.
 *
 * @returns {string} The config module source.
 */
function bundleConfigSource() {
  return [
    '// GENERATED by scripts/build-guest.mjs — do not edit.',
    '// rolldown takes `resolve.alias` as a plain record, not the Vite array',
    '// form; longer keys are listed first so subpaths win over the bare name.',
    'export default {',
    '  resolve: {',
    '    alias: {',
    `      'gameable/sdk/keycodes': '${SDK_SRC}/keycodes.ts',`,
    `      'gameable/sdk/prelude': '${SDK_SRC}/prelude.ts',`,
    `      'gameable': '${SDK_SRC}/index.ts',`,
    '    },',
    '  },',
    '};',
    '',
  ].join('\n');
}

/**
 * Write a file only when its contents would change, so mtimes stay meaningful.
 *
 * @param {string} path Absolute path.
 * @param {string} contents What it should hold.
 * @returns {void}
 */
function writeIfChanged(path, contents) {
  if (existsSync(path) && readFileSync(path, 'utf8') === contents) return;
  writeFileSync(path, contents, 'utf8');
}

/**
 * Build the guest component if anything changed.
 *
 * @param {{ force?: boolean, quiet?: boolean }} options Build options.
 * @returns {{ built: boolean, guestEntry: string, guestDir: string }} What happened.
 */
export function buildGuest(options = {}) {
  const quiet = options.quiet ?? false;
  const builtAt = newest(GUEST_ENTRY);
  let sourceAt = 0;
  for (const path of [...SOURCE_DIRS, ...SOURCE_FILES]) sourceAt = Math.max(sourceAt, newest(path));

  if (!options.force && builtAt > 0 && builtAt >= sourceAt) {
    if (!quiet) console.log('guest: up to date');
    return { built: false, guestEntry: GUEST_ENTRY, guestDir: GUEST_DIR };
  }

  const wit = findWit();
  mkdirSync(BUILD, { recursive: true });
  const entryPath = `${BUILD}/entry.ts`;
  writeIfChanged(entryPath, entrySource());
  const bundleConfigPath = `${BUILD}/rolldown.config.mjs`;
  writeIfChanged(bundleConfigPath, bundleConfigSource());

  if (!quiet) console.log('guest: componentize');
  jco(
    [
      'componentize',
      '--backend',
      'qjs',
      '--backend-qjs-disable-async',
      '-n',
      'game-module',
      '--wit',
      wit,
      '--bundle-config',
      bundleConfigPath,
      '-o',
      WASM,
      entryPath,
    ],
    quiet,
  );

  if (!quiet) console.log('guest: transpile');
  jco(
    [
      'transpile',
      WASM,
      '--instantiation',
      'async',
      '--no-nodejs-compat',
      '--name',
      'game',
      '-o',
      GUEST_DIR,
      '--quiet',
    ],
    quiet,
  );

  if (!quiet) {
    const bytes = statSync(WASM).size;
    console.log(`guest: built ${(bytes / 1024 / 1024).toFixed(2)} MiB component`);
  }
  return { built: true, guestEntry: GUEST_ENTRY, guestDir: GUEST_DIR };
}

const invokedDirectly =
  process.argv[1] !== undefined && slash(process.argv[1]).endsWith('scripts/build-guest.mjs');

if (invokedDirectly) {
  buildGuest({ force: process.argv.includes('--force'), quiet: process.argv.includes('--quiet') });
}
