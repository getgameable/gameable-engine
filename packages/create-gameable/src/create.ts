/**
 * `npm create gameable my-game -- --template fps`.
 *
 * Flags win; prompts only appear when a flag is missing **and** stdin is a TTY.
 * A non-interactive run — CI, an agent, `npm create` inside a script — takes the
 * defaults and never blocks on a question nobody can answer.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';

import { flagBool, flagString, parseArgs } from './args.js';
import { absPosix, findRepoRoot, packageDirOf, relativeSpecifier } from './paths.js';
import { findNpmCli, run } from './run.js';
import { scaffold } from './scaffold.js';
import { chooserLines, listTemplates, type Template } from './templates.js';
import { toPackageName, toTitle } from './tokens.js';
import type { LinkMode, VersionContext } from './versions.js';

/** Options `create-gameable` accepts. */
export const CREATE_SPEC = {
  boolean: ['install', 'git', 'aam', 'third-person', 'force', 'help', 'version', 'list'],
  value: ['template', 'title', 'packages-dir'],
  alias: { t: 'template', h: 'help', v: 'version', f: 'force' },
} as const;

/** One screen of help. */
export const CREATE_HELP = `
create-gameable — start a new gameable game

  npm create gameable my-game -- --template fps

  --template <name>   which scaffold to copy (default: fps)
  --list              print the templates and multiplayer kits, one line each
  --third-person      shorthand for --template third-person
  --title "<text>"    human title for the README and the page title
  --packages-dir <dir> install engine tarballs from npm pack, without source links
  --no-install        skip npm install
  --no-git            skip git init
  --aam               wire up the AvatarOS Asset Manager keys in .env.example
  --force             write into a directory that already has files in it

With no arguments, and an interactive terminal, it asks. Otherwise it takes the
defaults and never blocks.
`.trim();

/**
 * Run the scaffolder.
 *
 * @param argv Arguments after the executable and script.
 * @param cwd Directory the target path is resolved against.
 * @returns The process exit code.
 */
export async function main(argv: readonly string[], cwd: string): Promise<number> {
  const { flags, positionals, unknown } = parseArgs(argv, CREATE_SPEC);
  if (unknown.length > 0) {
    console.error(`error: unknown option ${unknown.join(', ')}`);
    console.error(CREATE_HELP);
    return 1;
  }
  if (flagBool(flags, 'help', false)) {
    console.log(CREATE_HELP);
    return 0;
  }
  if (flagBool(flags, 'version', false)) {
    console.log(ownVersion());
    return 0;
  }

  const templates = listTemplates(cwd);
  if (templates.length === 0) {
    console.error('error: no templates are installed.');
    console.error('       This package ships templates/ in its tarball; a checkout uses the');
    console.error('       repository templates/. Set GAMEABLE_TEMPLATES to point at one.');
    return 1;
  }

  if (flagBool(flags, 'list', false)) {
    for (const line of chooserLines(templates)) console.log(line);
    return 0;
  }

  // Typed `boolean`, actually `undefined` when the stream is not a terminal.
  const interactive = process.stdin.isTTY && process.stdout.isTTY;

  const target = positionals.at(0) ?? (interactive ? await askDirectory() : 'my-game');
  const targetDir = absPosix(cwd, target);
  const name = toPackageName(target.split('/').pop() ?? target);

  const requested = flagBool(flags, 'third-person', false)
    ? 'third-person'
    : !Object.hasOwn(flags, 'template') && interactive && templates.length > 1
      ? await askTemplate(templates)
      : flagString(flags, 'template', defaultTemplate(templates));

  const template = templates.find((candidate) => candidate.name === requested);
  if (template === undefined) {
    console.error(`error: no template called "${requested}".`);
    console.error(`       Available: ${templates.map((t) => t.name).join(', ')}`);
    for (const line of chooserLines(templates)) console.error(line);
    return 1;
  }

  if (!flagBool(flags, 'force', false) && existsSync(targetDir)) {
    const entries = readdirSync(targetDir);
    if (entries.length > 0) {
      console.error(`error: ${targetDir} already exists and is not empty.`);
      console.error('       Pass --force to write into it anyway.');
      return 1;
    }
  }

  const version = ownVersion();
  const repoRoot = findRepoRoot(template.dir) ?? findRepoRoot(cwd);
  const packed = flagString(flags, 'packages-dir', '');
  const packagesDir = packed === '' ? undefined : absPosix(cwd, packed);
  const mode: LinkMode =
    packagesDir !== undefined ? 'packed' : repoRoot === undefined ? 'semver' : 'file';
  const versions: VersionContext = { mode, version, repoRoot, packagesDir, gameDir: targetDir };

  const title = flagString(flags, 'title', toTitle(name));
  const aam = flagBool(flags, 'aam', false);

  console.log(`\ncreating ${name} from the ${template.name} template`);
  const result = scaffold({
    targetDir,
    templateDir: template.dir,
    manifest: template.manifest,
    name,
    title,
    versions,
    aam,
  });
  console.log(`  ${String(result.files.length)} files -> ${targetDir}`);
  if (mode === 'file') {
    console.log(`  engine packages linked with file: into ${repoRoot ?? ''}`);
  }

  if (flagBool(flags, 'git', true)) await gitInit(targetDir);
  const installed = flagBool(flags, 'install', true) ? await npmInstall(targetDir) : false;

  printNextSteps(relativeSpecifier(absPosix(cwd), targetDir), installed, template);
  return 0;
}

/**
 * This package's version, read from its own manifest.
 *
 * @returns The version string, or `0.0.0` when the manifest is unreadable.
 */
export function ownVersion(): string {
  try {
    const path = `${packageDirOf(import.meta.url)}/package.json`;
    const json = JSON.parse(readFileSync(path, 'utf8')) as { version?: unknown };
    return typeof json.version === 'string' ? json.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/**
 * Ask for the game directory.
 *
 * @returns What the user typed, or `my-game`.
 */
async function askDirectory(): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question('Game directory: (my-game) ');
    return answer.trim() === '' ? 'my-game' : answer.trim();
  } finally {
    rl.close();
  }
}

/**
 * @param templates Everything installed, sorted by name.
 * @returns `fps` when it is installed (the help's default), else the first.
 */
function defaultTemplate(templates: readonly Template[]): string {
  return templates.some((t) => t.name === 'fps') ? 'fps' : (templates[0]?.name ?? 'fps');
}

/**
 * Ask which template to copy.
 *
 * @param templates Everything installed.
 * @returns The chosen template name.
 */
async function askTemplate(templates: readonly Template[]): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    console.log('');
    for (const line of chooserLines(templates)) console.log(line);
    const fallback = defaultTemplate(templates);
    const answer = await rl.question(`Template: (${fallback}) `);
    const trimmed = answer.trim();
    if (trimmed === '') return fallback;
    const byIndex = Number.parseInt(trimmed, 10);
    if (Number.isFinite(byIndex) && byIndex >= 1 && byIndex <= templates.length) {
      return templates[byIndex - 1]?.name ?? trimmed;
    }
    return trimmed;
  } finally {
    rl.close();
  }
}

/**
 * Initialise a git repository, quietly tolerating a missing git.
 *
 * @param targetDir The new game directory.
 */
async function gitInit(targetDir: string): Promise<void> {
  if (existsSync(`${targetDir}/.git`)) return;
  const result = await run('git', ['init', '--initial-branch=main'], targetDir);
  console.log(result.status === 0 ? '  git init' : '  git init skipped (git is not installed)');
}

/**
 * Install the game's dependencies.
 *
 * @param targetDir The new game directory.
 * @returns True when `npm install` succeeded.
 */
async function npmInstall(targetDir: string): Promise<boolean> {
  const npmCli = findNpmCli();
  if (npmCli === undefined) {
    console.log('  npm install skipped (could not find npm)');
    return false;
  }
  console.log('  npm install (this takes a minute)');
  const result = await run(
    process.execPath,
    [npmCli, 'install', '--no-audit', '--no-fund'],
    targetDir,
    true,
  );
  if (result.status === 0) return true;
  console.log('  npm install failed; run it yourself in the new directory');
  return false;
}

/**
 * Print what to do next.
 *
 * @param relativeDir The new directory, relative to where the command was run.
 * @param installed Whether dependencies are already installed.
 * @param template The template that was copied.
 */
function printNextSteps(relativeDir: string, installed: boolean, template: Template): void {
  const steps = [`cd ${relativeDir}`];
  if (!installed) steps.push('npm install');
  steps.push('npm run dev');

  console.log('');
  console.log('  Next:');
  for (const step of steps) console.log(`    ${step}`);
  console.log('');
  console.log('  Then open http://localhost:5173 and edit src/game.ts.');
  console.log('  npx gameable doctor      check the toolchain');
  console.log('  npx gameable docs        where the llms*.txt bundles are');
  console.log(`  AGENTS.md                 the rules, scoped to this game (${template.name})`);
  console.log('');
}
