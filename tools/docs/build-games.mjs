#!/usr/bin/env node
/**
 * Build the playable examples into the docs site.
 *
 * Each game is a normal Vite app; this runs its production build with a
 * `--base` of `/play/<name>/` and points `--outDir` at
 * `docs/public/play/<name>/`. VitePress copies `docs/public/` verbatim, so the
 * dev server and the production build both serve the games at that path and
 * `docs/play.md` links straight to them. The output is gitignored, like
 * `docs/api/`: run this before `docs:dev` or `docs:build` when you want the
 * games there.
 *
 * Games with a wasm guest build it first (`scripts/build-guest.mjs`), so what
 * gets hosted is the shipping sandbox, not the direct-mode one.
 *
 * Usage:
 *   node tools/docs/build-games.mjs           build every game
 *   node tools/docs/build-games.mjs fps       build one (or more) by name
 *   node tools/docs/build-games.mjs --clean   remove docs/public/play/ first
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { multiplayerKits } from '../../packages/cli/scripts/kits.mjs';

/**
 * Absolute, forward-slashed path.
 *
 * @param {string} path Any path.
 * @returns {string} The same path with forward slashes and no trailing one.
 */
function slash(path) {
  return path.replaceAll('\\', '/').replace(/\/$/, '');
}

/** The repository root. */
const ROOT = slash(fileURLToPath(new URL('../../', import.meta.url)));
/** Where the built games land; VitePress serves it at `/play/`. */
const OUT = `${ROOT}/docs/public/play`;

/**
 * The hosted games. `name` is the URL segment under `/play/`, `dir` the
 * workspace directory, `guest` whether the app ships a wasm component that
 * has to be built first, `sdkDist` whether that guest build bundles the SDK
 * from its built `dist/` (every template, and examples copied from one).
 * The single-player games are listed; every multiplayer kit (a template whose
 * `src/game.ts` declares `features.multiplayer`) is found by
 * `packages/cli/scripts/kits.mjs`, so a new kit is hosted without an edit here.
 * Each needs its card in `docs/play.md` (`tools/docs/play.test.mjs` checks).
 *
 * @type {{ name: string; dir: string; guest: boolean; sdkDist: boolean }[]}
 */
export const GAMES = [
  { name: 'fps', dir: 'templates/fps', guest: true, sdkDist: true },
  { name: 'third-person', dir: 'templates/third-person', guest: true, sdkDist: true },
  { name: 'wasm-hello', dir: 'examples/wasm-hello', guest: true, sdkDist: false },
  { name: 'visit', dir: 'templates/visit', guest: true, sdkDist: true },
  ...multiplayerKits(ROOT).map((kit) => ({ name: kit.name, dir: kit.dir, guest: true, sdkDist: true })),
];

/**
 * Run a command in a workspace directory, inheriting stdio.
 *
 * @param {string} cwd Absolute directory.
 * @param {string} cmd The executable.
 * @param {string[]} args Its arguments.
 * @returns {boolean} Whether it exited zero.
 */
function run(cwd, cmd, args) {
  const result = spawnSync(cmd, args, { cwd, stdio: 'inherit', shell: true });
  return result.status === 0;
}

/**
 * Build one game into `docs/public/play/<name>/`.
 *
 * @param {{ name: string; dir: string; guest: boolean; sdkDist: boolean }} game Which one.
 * @returns {boolean} Whether the build succeeded.
 */
function build(game) {
  const cwd = `${ROOT}/${game.dir}`;
  const outDir = `${OUT}/${game.name}`;
  console.log(`\n▶ ${game.dir} → docs/public/play/${game.name}/`);
  if (game.name === 'wasm-hello' && !run(cwd, 'node', ['scripts/import-character.mjs', '--check']))
    return false;
  if (game.guest && !run(cwd, 'node', ['scripts/build-guest.mjs', '--quiet'])) return false;
  mkdirSync(outDir, { recursive: true });
  return run(cwd, 'npx', [
    'vite',
    'build',
    '--base',
    `/play/${game.name}/`,
    '--outDir',
    outDir,
    '--emptyOutDir',
  ]);
}

const args = process.argv.slice(2);
const clean = args.includes('--clean');
const names = args.filter((a) => !a.startsWith('--'));

const unknown = names.filter((n) => !GAMES.some((g) => g.name === n));
if (unknown.length > 0) {
  console.error(
    `unknown game(s): ${unknown.join(', ')}; known: ${GAMES.map((g) => g.name).join(', ')}`,
  );
  process.exit(1);
}

if (clean && existsSync(OUT)) rmSync(OUT, { recursive: true, force: true });

const selected = names.length > 0 ? GAMES.filter((g) => names.includes(g.name)) : GAMES;
const missing = selected.filter((g) => !existsSync(join(ROOT, g.dir, 'package.json')));
if (missing.length > 0) {
  console.error(`missing workspace(s): ${missing.map((g) => g.dir).join(', ')}`);
  process.exit(1);
}

// Template guests (and examples built from a template) resolve the installed
// SDK's public exports from dist/. A clean deployment has no package build
// outputs until we produce them here.
if (
  selected.some((game) => game.sdkDist) &&
  !run(ROOT, 'npm', ['run', 'build', '--workspace', 'packages/sdk'])
)
  process.exit(1);

const failed = selected.filter((g) => !build(g)).map((g) => g.dir);
if (failed.length > 0) {
  console.error(`\ngame build failed in: ${failed.join(', ')}`);
  process.exit(1);
}
console.log(`\nbuilt ${String(selected.length)} game(s) into docs/public/play/`);
