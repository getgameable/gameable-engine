#!/usr/bin/env node
/**
 * The multiplayer kits, found rather than listed: a directory under
 * `templates/` is a kit when its `src/game.ts` declares `features.multiplayer`.
 * The docs site (`tools/docs/build-games.mjs`), the room server image
 * (`deploy/rooms/Dockerfile`) and their tests all read this one list, so a kit
 * merged tomorrow is built, hosted and served without touching any of them.
 *
 * Node's own modules only: the image runs it before `npm ci`.
 *
 *     node packages/cli/scripts/kits.mjs                     one line per kit: dir, play name, catalog name
 *     node packages/cli/scripts/kits.mjs --workspaces        `--workspace templates/<kit>` for each, for npm ci
 *     node packages/cli/scripts/kits.mjs pack <games> --packer <pack.mjs>
 *         build each kit's wasm guest and write <games>/<catalog name>/dist/{guest,server}
 */
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The repository root. */
export const ROOT = fileURLToPath(new URL('../../../', import.meta.url)).replaceAll('\\', '/').replace(/\/$/, '');

/**
 * @param source A `src/game.ts`.
 * @returns True when its `defineGame` features declare `multiplayer`; comments do not count.
 */
export function declaresMultiplayer(source) {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  return /\bfeatures\s*:\s*\{[^}]*\bmultiplayer\s*:/.test(code);
}

/**
 * The room catalog's name for a package: its name without the npm scope, as
 * `catalogName` in `gameable/net/page` (the kits test pins the two together).
 *
 * @param packageName A `package.json` name.
 * @returns The catalog name.
 */
export function catalogNameOf(packageName) {
  const slash = packageName.startsWith('@') ? packageName.indexOf('/') : -1;
  return (slash === -1 ? packageName : packageName.slice(slash + 1)).trim();
}

/**
 * @param root The repository root.
 * @returns Every multiplayer kit, sorted by directory: `dir` (relative, such as
 *   `templates/mystery`), `name` (its `/play/<name>/` segment) and `catalog`
 *   (the room server's name for it, such as `example-mystery`).
 */
export function multiplayerKits(root = ROOT) {
  const templates = join(root, 'templates');
  if (!existsSync(templates)) return [];
  const kits = [];
  for (const entry of readdirSync(templates, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = join(templates, entry.name);
    const game = join(dir, 'src/game.ts');
    const pkg = join(dir, 'package.json');
    if (!existsSync(game) || !existsSync(pkg)) continue;
    if (!declaresMultiplayer(readFileSync(game, 'utf8'))) continue;
    const { name } = JSON.parse(readFileSync(pkg, 'utf8'));
    kits.push({ dir: `templates/${entry.name}`, name: entry.name, catalog: catalogNameOf(String(name ?? '')) });
  }
  return kits.sort((a, b) => (a.dir < b.dir ? -1 : 1));
}

/**
 * @param cwd Where to run.
 * @param args `node` arguments.
 */
function node(cwd, args) {
  const result = spawnSync(process.execPath, args, { cwd, stdio: 'inherit' });
  if (result.status !== 0) throw new Error(`node ${args.join(' ')} failed in ${cwd}`);
}

/**
 * Build every kit's wasm guest and pack it as a room server reads it:
 * `<gamesDir>/<catalog>/dist/guest` (the kit's `build/guest`) and
 * `<gamesDir>/<catalog>/dist/server` (written by `packer`, the bundled `pack.mjs`).
 *
 * @param gamesDir Where the games go.
 * @param packer The bundled `pack.mjs` (`bundle-server.mjs --pack`).
 * @param root The repository root.
 * @returns The kits packed.
 */
export function packKits(gamesDir, packer, root = ROOT) {
  const kits = multiplayerKits(root);
  for (const kit of kits) {
    const kitDir = join(root, kit.dir);
    const dist = join(gamesDir, kit.catalog, 'dist');
    console.log(`kit ${kit.dir} -> ${dist}`);
    node(kitDir, ['scripts/build-guest.mjs', '--quiet']);
    rmSync(dist, { recursive: true, force: true });
    mkdirSync(dist, { recursive: true });
    cpSync(join(kitDir, 'build/guest'), join(dist, 'guest'), { recursive: true });
    node(kitDir, [resolve(packer), kitDir, dist]);
  }
  return kits;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const kits = multiplayerKits();
  if (kits.length === 0) {
    console.error(`no multiplayer kit under ${ROOT}/templates`);
    process.exit(1);
  }
  if (args[0] === 'pack') {
    const packer = args[args.indexOf('--packer') + 1];
    if (args[1] === undefined || !args.includes('--packer') || packer === undefined) {
      console.error('usage: node kits.mjs pack <gamesDir> --packer <pack.mjs>');
      process.exit(1);
    }
    packKits(resolve(args[1]), packer);
  } else if (args.includes('--workspaces')) {
    console.log(kits.map((k) => `--workspace ${k.dir}`).join(' '));
  } else {
    for (const k of kits) console.log(`${k.dir}\t${k.name}\t${k.catalog}`);
  }
}
