/**
 * `gameable docs` — where the documentation actually is on this machine.
 *
 * The bundles a language model should read (`llms-<topic>.txt` for each
 * template, kit and topic, `llms.txt`, `llms-full.txt`) ship with the engine.
 * This command prints their absolute paths, because "read the docs" is useless
 * advice to an agent that cannot find them, and `--open` hands one to the
 * operating system.
 */
import { existsSync } from 'node:fs';

import { flagBool, parseArgs } from '../lib/args.js';
import { color, mark } from '../lib/colors.js';
import { absPosix, findRepoRoot, packageDirOf, resolvePackageDir } from '../lib/paths.js';
import { run } from '../lib/run.js';

/**
 * The committed bundles, in the order they are printed: every output of
 * `tools/docs/llms/budgets.mjs` (`docs.test.ts` holds the two together, so a
 * new bundle fails the test until it is listed here with its line).
 */
export const BUNDLES = [
  { name: 'llms-fps.txt', what: 'first-person shooter: read this one to build an FPS' },
  { name: 'llms-third-person.txt', what: 'third-person adventure' },
  { name: 'llms-three-character.txt', what: 'a studio character in any three.js app' },
  { name: 'llms-visit.txt', what: "a character's page (templates/visit)" },
  { name: 'llms-multiplayer.txt', what: 'rooms, players and gameable serve' },
  { name: 'llms-character.txt', what: 'studio characters: rigs, animation, faces' },
  { name: 'llms-mystery.txt', what: 'the mystery kit: a hidden-role round for 3 to 6 players' },
  { name: 'llms-survive.txt', what: 'the survive kit: day/night survival for 4 to 6 players' },
  { name: 'llms-hangout.txt', what: 'the hangout kit: a street for up to 12 friends' },
  { name: 'llms-brawl.txt', what: 'the brawl kit: a fighting arena for 2 to 4 players' },
  { name: 'llms-steal.txt', what: 'the steal kit: grab, steal and saved progress for up to 6' },
  { name: 'llms-collect.txt', what: 'the collect kit: eggs, pets and trades for up to 8' },
  { name: 'llms.txt', what: 'the index' },
  { name: 'llms-full.txt', what: 'the corpus minus the topic bundles above (360 KB cap)' },
] as const;

/** Options `gameable docs` accepts. */
export const DOCS_SPEC = {
  boolean: ['open', 'help'],
  alias: { h: 'help', o: 'open' },
} as const;

/** One screen of help. */
export const DOCS_HELP = `
${color.bold('gameable docs')} — print paths to the documentation bundles

  gameable docs                 list every bundle and where it is
  gameable docs fps --open      open llms-fps.txt
  gameable docs --open          open the docs site

Names may be abbreviated: fps, third-person, multiplayer, mystery, index, full.
`.trim();

/**
 * Every directory that might hold the bundles, best first.
 *
 * @param cwd The game directory.
 * @returns Absolute, forward-slashed candidate directories.
 */
export function docsRoots(cwd: string): string[] {
  const gameDir = absPosix(cwd);
  const cliDir = packageDirOf(import.meta.url);
  const roots = [
    gameDir,
    findRepoRoot(gameDir),
    resolvePackageDir(gameDir, 'gameable'),
    findRepoRoot(cliDir),
    cliDir,
  ];
  return [...new Set(roots.filter((root): root is string => root !== undefined))];
}

/**
 * Resolve one bundle by file name.
 *
 * @param cwd The game directory.
 * @param fileName A bundle file name, for example `llms-fps.txt`.
 * @returns The absolute path, or `undefined` when it is not installed.
 */
export function findBundle(cwd: string, fileName: string): string | undefined {
  for (const root of docsRoots(cwd)) {
    const candidate = `${root}/${fileName}`;
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

/**
 * Expand an abbreviation to a bundle file name.
 *
 * @param alias What the user typed, or `undefined`.
 * @returns The file name, or `undefined` when nothing was asked for.
 */
export function bundleForAlias(alias: string | undefined): string | undefined {
  if (alias === undefined) return undefined;
  const lower = alias.toLowerCase();
  const direct = BUNDLES.find((bundle) => bundle.name === lower);
  if (direct) return direct.name;
  if (lower === 'fps') return 'llms-fps.txt';
  if (lower === 'third-person' || lower === 'tp') return 'llms-third-person.txt';
  if (lower === 'three' || lower === 'character') return 'llms-three-character.txt';
  if (lower === 'visit') return 'llms-visit.txt';
  if (lower === 'multiplayer' || lower === 'mp') return 'llms-multiplayer.txt';
  if (lower === 'index') return 'llms.txt';
  if (lower === 'full') return 'llms-full.txt';
  // A kit or topic by its own name: `mystery` is llms-mystery.txt.
  return BUNDLES.find((bundle) => bundle.name === `llms-${lower}.txt`)?.name;
}

/**
 * Print or open the documentation.
 *
 * @param argv Arguments after `docs`.
 * @param cwd The game directory.
 * @returns The process exit code.
 */
export async function docsCommand(argv: readonly string[], cwd: string): Promise<number> {
  const { flags, positionals, unknown } = parseArgs(argv, DOCS_SPEC);
  if (unknown.length > 0) {
    console.error(`${mark.fail} unknown option: ${unknown.join(', ')}`);
    console.error(DOCS_HELP);
    return 1;
  }
  if (flagBool(flags, 'help', false)) {
    console.log(DOCS_HELP);
    return 0;
  }

  const wantOpen = flagBool(flags, 'open', false);
  const requested = positionals.at(0);
  const alias = bundleForAlias(requested);
  if (requested !== undefined && alias === undefined) {
    console.error(
      `${mark.fail} unknown bundle "${requested}". Try: fps, third-person, index, full.`,
    );
    return 1;
  }

  if (alias !== undefined) {
    const path = findBundle(cwd, alias);
    if (path === undefined) {
      console.error(`${mark.fail} ${alias} is not installed anywhere I can see.`);
      console.error(`       ${color.gray('Looked in: ' + docsRoots(cwd).join(', '))}`);
      return 1;
    }
    console.log(path);
    if (wantOpen) await openPath(path);
    return 0;
  }

  console.log(color.bold('gameable docs'));
  console.log('');
  const width = BUNDLES.reduce((max, bundle) => Math.max(max, bundle.name.length), 0);
  let missing = 0;
  for (const bundle of BUNDLES) {
    const path = findBundle(cwd, bundle.name);
    if (path === undefined) missing += 1;
    console.log(
      `  ${bundle.name.padEnd(width)}  ${path === undefined ? color.yellow('not installed') : color.cyan(path)}`,
    );
    console.log(`  ${' '.repeat(width)}  ${color.gray(bundle.what)}`);
  }
  console.log('');
  console.log(
    `  ${color.gray('Start here: AGENTS.md, then llms-fps.txt. Copy a template, edit src/game.ts.')}`,
  );

  if (missing === BUNDLES.length) {
    console.log('');
    console.log(`${mark.warn} no bundles found. They ship with the engine repository.`);
  }

  if (wantOpen) {
    const index = findBundle(cwd, 'llms.txt');
    if (index !== undefined) await openPath(index);
  }
  return 0;
}

/**
 * Hand a path to the operating system's opener.
 *
 * No shell, so `start` is out on Windows; `explorer.exe` does the same job and
 * is a real executable. `explorer` exits non-zero even on success, which is why
 * its status is ignored.
 *
 * @param path Absolute path to open.
 * @returns Nothing.
 */
async function openPath(path: string): Promise<void> {
  const opener =
    process.platform === 'win32'
      ? 'explorer.exe'
      : process.platform === 'darwin'
        ? 'open'
        : 'xdg-open';
  await run(opener, [path]);
}
