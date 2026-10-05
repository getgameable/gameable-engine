/**
 * Getting a fresh, installed game in front of the model — twenty times, fast.
 *
 * ## Why `node_modules` is a junction and not a copy
 *
 * A scaffolded FPS is 165 packages and **401 MB** on disk. Measured on this
 * repository (Windows, warm npm cache, node 24.14):
 *
 * | Approach                             | Per prompt | 20 prompts | Disk   |
 * | ------------------------------------ | ---------- | ---------- | ------ |
 * | `npm install` in every game dir      | 18.6 s     | 6 m 12 s   | 8.0 GB |
 * | `cp -r` a cached `node_modules`      | 11.4 s     | 3 m 48 s   | 8.0 GB |
 * | **junction/symlink to one install**  | **0.16 s** | **3 s**    | 401 MB |
 *
 * So: install **once** into a cache directory, then give every game directory
 * a directory junction (Windows, no elevation needed) or a symlink (POSIX)
 * pointing at that one `node_modules`. `--install-links` was not used: it makes
 * npm *copy* the `file:` engine packages instead of linking them, which is the
 * slow column above and also freezes the engine at install time, which is the
 * opposite of what a repository-linked eval wants.
 *
 * Copying is kept as the fallback for the one case junctions cannot cover (a
 * filesystem or policy that refuses them), and the runner says which it used.
 *
 * The shared install is read-mostly: a build writes `dist/` and `.gameable/`
 * into the *game* directory, not into `node_modules`. Vite's dependency
 * pre-bundling cache does live under `node_modules/.vite`, which is why the
 * runner scores prompts sequentially.
 */
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { run, toPosix } from './proc.ts';
import type { StageName } from './prompts.ts';
import { stageBuild, stageTypecheck, stageUnit, type StageResult } from './stages.ts';

/** This file's directory, forward-slashed. */
const HERE = toPosix(dirname(fileURLToPath(import.meta.url)));

/**
 * Walk up until something looks like the engine checkout.
 *
 * @param from Where to start. Defaults to this file.
 * @returns The absolute, forward-slashed repository root.
 */
export function findRepoRoot(from: string = HERE): string {
  let dir = resolve(from);
  for (;;) {
    if (existsSync(join(dir, 'wit')) && existsSync(join(dir, 'packages', 'sdk'))) {
      return toPosix(dir);
    }
    const parent = dirname(dir);
    if (parent === dir) {
      throw new Error(`could not find the gameable checkout above ${from}`);
    }
    dir = parent;
  }
}

/** A template the harness can scaffold from. */
export interface ResolvedTemplate {
  /** `fps`, `third-person`, or `tiny-game` when standing in for a missing one. */
  readonly name: string;
  /** Absolute, forward-slashed directory. */
  readonly dir: string;
  /** Set when this is not the template the prompt asked for. */
  readonly substituteFor?: string;
}

/**
 * Is this directory a template a game can actually be scaffolded from?
 *
 * A `package.json` alone is not enough. Templates land in pieces, and a
 * half-written one is worse than a missing one: the eval would scaffold it,
 * fail every stage, and report a model that never had a chance. The entry
 * point is the test, because `src/main.ts` reaches the game through
 * `await import('./game')` and every prompt edits `src/game.ts`.
 *
 * @param dir A candidate directory.
 * @returns True when it has both a manifest and an entry point.
 */
export function isUsableTemplate(dir: string): boolean {
  return existsSync(join(dir, 'package.json')) && existsSync(join(dir, 'src', 'game.ts'));
}

/**
 * Find a template, tolerating one that another agent has not finished yet.
 *
 * @param repoRoot The engine checkout.
 * @param name The template the prompt asked for.
 * @param override An explicit `--template-dir`, which always wins.
 * @returns The template to scaffold, or `undefined` when there is no usable one.
 */
export function resolveTemplate(
  repoRoot: string,
  name: string,
  override?: string,
): ResolvedTemplate | undefined {
  if (override !== undefined && override !== '') {
    const dir = toPosix(resolve(override));
    if (!existsSync(join(dir, 'package.json'))) {
      throw new Error(`--template-dir ${dir} has no package.json`);
    }
    return { name, dir };
  }
  const authored = `${repoRoot}/templates/${name}`;
  return isUsableTemplate(authored) ? { name, dir: authored } : undefined;
}

/** Where a prepared, installed game lives. */
export interface Workspace {
  /** Absolute path to the cache directory holding the one real install. */
  readonly cacheDir: string;
  /** Absolute path to the shared `node_modules`. */
  readonly nodeModules: string;
  /** The template that was installed. */
  readonly template: ResolvedTemplate;
  /** Packages that had to be added for the scaffold to typecheck at all. */
  readonly repairs: readonly string[];
  /** How game directories get their `node_modules`. */
  readonly linkMode: 'junction' | 'copy';
  /**
   * What the *untouched* scaffold scores, before any model touches it.
   *
   * Anything red here is red for reasons that have nothing to do with a model:
   * the `file:` links mean a game typechecks the engine's live source, and a
   * template's own vitest suite can be mid-rewrite. The runner skips a stage
   * that is already failing rather than charging it to every prompt, and says
   * so at the top of the scoreboard instead of reporting 0%.
   */
  readonly baseline: Baseline;
}

/** The pristine scaffold's own score. */
export type Baseline = Readonly<
  Record<BaselineStage, { readonly status: 'pass' | 'fail'; readonly detail?: string }>
>;

/** Stages the baseline probe can answer without a model. */
export type BaselineStage = 'typecheck' | 'unit' | 'build';

/** The stages the baseline probe runs, in order. */
export const BASELINE_STAGES: readonly BaselineStage[] = ['typecheck', 'unit', 'build'];

/** Options for {@link prepareWorkspace}. */
export interface PrepareOptions {
  /** The engine checkout. */
  readonly repoRoot: string;
  /** Which template to install. */
  readonly template: ResolvedTemplate;
  /** Where the shared install lives. Default `<tmp>/gameable-llm-eval`. */
  readonly cacheRoot?: string;
  /** Install again even if the cache looks complete. */
  readonly fresh?: boolean;
  /** Where progress goes. */
  readonly log?: (line: string) => void;
}

/**
 * Packages a scaffolded game needs to typecheck but does not declare.
 *
 * Inside the monorepo these are hoisted root devDependencies, so the template
 * typechecks in CI and fails the moment it is scaffolded anywhere else. The
 * harness adds them only when the pristine scaffold genuinely fails without
 * them, and records that it did — see the README's "Known template gaps".
 */
const REPAIR_CANDIDATES: readonly { spec: (repoRoot: string) => string; why: string }[] = [
  { spec: () => '@types/node@26.5.1', why: 'tsconfig sets types: ["node"]' },
  { spec: () => '@webgpu/types@0.1.72', why: 'tsconfig sets types: ["@webgpu/types"]' },
  { spec: () => '@types/three@0.186.0', why: "src/main.ts imports 'three/webgpu'" },
  {
    spec: (repoRoot) => `file:${repoRoot}/packages/assets`,
    why: "src/main.ts imports 'gameable/assets'",
  },
];

/**
 * Scaffold once, install once, and find out what the pristine scaffold scores.
 *
 * @param options Repository, template and cache location.
 * @returns The shared install, and anything that had to be repaired.
 */
export async function prepareWorkspace(options: PrepareOptions): Promise<Workspace> {
  const log = options.log ?? ((): void => {});
  const cacheRoot = toPosix(
    resolve(
      options.cacheRoot ??
        process.env['GAMEABLE_LLM_EVAL_CACHE'] ??
        join(tmpdir(), 'gameable-llm-eval'),
    ),
  );
  const cacheDir = `${cacheRoot}/${options.template.name}`;
  const nodeModules = `${cacheDir}/node_modules`;

  if (options.fresh === true && existsSync(cacheDir)) {
    log(`  cache: removing ${cacheDir}`);
    rmSync(cacheDir, { recursive: true, force: true });
  }

  // Templates are being written while the eval is being written, so a cache
  // from an hour ago can be scaffolded from a template that has since grown a
  // test suite or a dependency. The stamp is the template's newest mtime at
  // scaffold time; anything newer means re-scaffold.
  const stamp = `${cacheDir}/.llm-eval-template-mtime`;
  const templateMtime = newestMtime(options.template.dir);
  const installed = existsSync(`${nodeModules}/typescript`);
  const stale =
    installed && (!existsSync(stamp) || Number(readFileSync(stamp, 'utf8').trim()) < templateMtime);

  if (!installed || stale) {
    if (stale) {
      log(
        `  cache: ${options.template.name} has changed since the cache was built; re-scaffolding`,
      );
      // node_modules survives: the install below is a no-op when nothing moved,
      // and re-downloading 165 packages to pick up an edited game file is silly.
      for (const entry of readdirSync(cacheDir)) {
        if (entry === 'node_modules') continue;
        rmSync(join(cacheDir, entry), { recursive: true, force: true });
      }
    } else {
      rmSync(cacheDir, { recursive: true, force: true });
      mkdirSync(cacheRoot, { recursive: true });
      log(`  cache: scaffolding ${options.template.name} into ${cacheDir}`);
    }
    await scaffoldGame({
      repoRoot: options.repoRoot,
      template: options.template,
      targetDir: cacheDir,
    });
    log('  cache: npm install (once per run, then junctioned into every game dir)');
    const install = await run(process.execPath, [npmCli(), 'install', '--no-audit', '--no-fund'], {
      cwd: cacheDir,
      timeoutMs: 900_000,
    });
    if (install.status !== 0) {
      throw new Error(`npm install failed in the eval cache:\n${install.output}`);
    }
    writeFileSync(stamp, `${String(templateMtime)}\n`, 'utf8');
  } else {
    log(`  cache: reusing the install at ${cacheDir}`);
  }

  const repairs = await repairScaffold(cacheDir, options.repoRoot, log);
  const baseline = await probeBaseline(cacheDir, options.repoRoot, log);
  const linkMode = probeLinkMode(cacheRoot);

  return { cacheDir, nodeModules, template: options.template, repairs, linkMode, baseline };
}

/**
 * Score the untouched scaffold, so a red template is never charged to a model.
 *
 * Runs the three stages that need no browser, in the shared cache directory
 * itself. About four seconds, once per run, and it is the difference between
 * "the model failed" and "the repository is mid-rewrite".
 *
 * @param cacheDir The shared install.
 * @param repoRoot The engine checkout.
 * @param log Where progress goes.
 * @returns One verdict per baseline stage.
 */
async function probeBaseline(
  cacheDir: string,
  repoRoot: string,
  log: (line: string) => void,
): Promise<Baseline> {
  const ctx = { gameDir: cacheDir, repoRoot, skip: new Set<StageName>() };
  const runners: Readonly<Record<BaselineStage, (c: typeof ctx) => Promise<StageResult>>> = {
    typecheck: stageTypecheck,
    unit: stageUnit,
    build: stageBuild,
  };

  const entries = await Promise.all(
    BASELINE_STAGES.map(async (name) => {
      const result = await runners[name](ctx);
      // A stage the machine cannot answer is not a baseline failure; the
      // per-prompt run will report it as skipped for the same reason.
      const status = result.status === 'fail' ? ('fail' as const) : ('pass' as const);
      return [
        name,
        { status, ...(status === 'fail' ? { detail: tail(result.detail ?? '') } : {}) },
      ] as const;
    }),
  );
  const baseline = Object.fromEntries(entries) as Baseline;

  const red = BASELINE_STAGES.filter((name) => baseline[name].status === 'fail');
  if (red.length > 0) {
    log('');
    log(`  cache: THE UNTOUCHED SCAFFOLD ALREADY FAILS: ${red.join(', ')}.`);
    log('  Those stages measure the repository, not the model, so they are skipped');
    log('  for every prompt and called out on the scoreboard. First lines:');
    for (const name of red) {
      for (const line of (baseline[name].detail ?? '').trim().split('\n').slice(0, 3)) {
        log(`    ${name}: ${line}`);
      }
    }
    log('');
  }
  return baseline;
}

/**
 * Typecheck the pristine scaffold; if it cannot, add the packages it is missing.
 *
 * This exists so a template bug does not silently become a model failure. If
 * the repair list ever comes back empty, the template has been fixed and this
 * function costs one `tsc` run.
 *
 * @param cacheDir The shared install.
 * @param repoRoot The engine checkout.
 * @param log Where progress goes.
 * @returns The specs that had to be added, empty when none were needed.
 */
async function repairScaffold(
  cacheDir: string,
  repoRoot: string,
  log: (line: string) => void,
): Promise<string[]> {
  // The repairs survive in the cache between runs, so the probe below would
  // come back green and silently drop the disclosure. The marker remembers.
  const marker = `${cacheDir}/.llm-eval-repairs.json`;
  const before = await run(
    process.execPath,
    [`${cacheDir}/node_modules/typescript/bin/tsc`, '-p', 'tsconfig.json', '--noEmit'],
    { cwd: cacheDir, timeoutMs: 300_000 },
  );
  if (before.status === 0) {
    if (!existsSync(marker)) return [];
    const remembered = JSON.parse(readFileSync(marker, 'utf8')) as string[];
    if (remembered.length > 0) {
      log(
        '  cache: the pristine scaffold needed extra packages to typecheck (from a previous run)',
      );
    }
    return remembered;
  }

  const specs = REPAIR_CANDIDATES.map((candidate) => candidate.spec(repoRoot));
  log('  cache: the pristine scaffold does not typecheck; adding the packages it omits');
  const install = await run(
    process.execPath,
    [npmCli(), 'install', '--no-save', '--no-audit', '--no-fund', ...specs],
    { cwd: cacheDir, timeoutMs: 900_000 },
  );
  if (install.status !== 0) {
    log('  cache: the repair install failed; the baseline probe will report the damage');
    return [];
  }
  // Recorded now, not after the re-probe: the install only runs when the probe
  // already failed, so these packages were needed whatever happens next, and
  // the next run's probe will be green because they are installed.
  writeFileSync(marker, `${JSON.stringify(specs, null, 2)}\n`, 'utf8');
  for (const candidate of REPAIR_CANDIDATES) {
    log(`    + ${candidate.spec(repoRoot)}  (${candidate.why})`);
  }
  return specs;
}

/**
 * The newest modification time anywhere under a directory.
 *
 * Build outputs and installs are skipped: a `dist/` from a previous build is
 * not a reason to re-scaffold, and walking `node_modules` would take longer
 * than the install it is trying to avoid.
 *
 * @param dir The directory to walk.
 * @returns Milliseconds since the epoch, or 0 when the directory is unreadable.
 */
export function newestMtime(dir: string): number {
  let newest = 0;
  /**
   * Recurse.
   *
   * @param current The directory being walked.
   * @returns Nothing.
   */
  const walk = (current: string): void => {
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (SKIP_WALK.has(entry.name) || entry.name.startsWith('.')) continue;
      const path = join(current, entry.name);
      if (entry.isDirectory()) {
        walk(path);
        continue;
      }
      try {
        newest = Math.max(newest, statSync(path).mtimeMs);
      } catch {
        // Raced with a write; the next run will see it.
      }
    }
  };
  walk(dir);
  return Math.round(newest);
}

/** Directories `newestMtime` does not look inside. */
const SKIP_WALK = new Set(['node_modules', 'dist', 'build', 'coverage', 'test-results']);

/**
 * Keep the tail of a blob, for a result file.
 *
 * @param text The output.
 * @param max How many characters to keep.
 * @returns The tail.
 */
function tail(text: string, max = 4000): string {
  const trimmed = text.trim();
  return trimmed.length > max ? `…${trimmed.slice(-max)}` : trimmed;
}

/** Options for {@link scaffoldGame}. */
export interface ScaffoldOptions {
  /** The engine checkout. */
  readonly repoRoot: string;
  /** What to copy. */
  readonly template: ResolvedTemplate;
  /** Where to put it. Created if missing, must be empty or absent. */
  readonly targetDir: string;
}

/**
 * `create-gameable <dir> --template <t> --no-install --no-git`.
 *
 * Run through the scaffolder's own binary rather than by copying the template
 * directory, because the token substitution and the `file:` dependency rewrite
 * are exactly the path a real user takes.
 *
 * @param options Repository, template and target.
 * @returns Nothing; throws when the scaffolder fails.
 */
export async function scaffoldGame(options: ScaffoldOptions): Promise<void> {
  const bin = `${options.repoRoot}/packages/create-gameable/bin/create-gameable.mjs`;
  if (!existsSync(bin)) {
    throw new Error(
      `${bin} is missing. Run \`npm run build -w packages/create-gameable\` once — the bin is two lines over dist/.`,
    );
  }
  mkdirSync(dirname(options.targetDir), { recursive: true });
  const result = await run(
    process.execPath,
    [
      bin,
      options.targetDir,
      '--template',
      options.template.name,
      '--no-install',
      '--no-git',
      '--force',
    ],
    {
      cwd: options.repoRoot,
      // The scaffolder finds templates relative to itself; point it at the one
      // we resolved, so `--template-dir` and a substituted template both work.
      env: { GAMEABLE_TEMPLATES: dirname(options.template.dir) },
      timeoutMs: 120_000,
    },
  );
  if (result.status !== 0) {
    throw new Error(`create-gameable failed:\n${result.output}`);
  }
}

/**
 * Give a game directory the shared `node_modules`.
 *
 * @param gameDir The scaffolded game.
 * @param workspace What {@link prepareWorkspace} returned.
 * @returns How it was linked.
 */
export function linkNodeModules(gameDir: string, workspace: Workspace): 'junction' | 'copy' {
  const target = `${gameDir}/node_modules`;
  rmSync(target, { recursive: true, force: true });
  if (workspace.linkMode === 'junction') {
    try {
      symlinkSync(workspace.nodeModules, target, 'junction');
      return 'junction';
    } catch {
      // Fall through: some filesystems and some group policies say no.
    }
  }
  cpSync(workspace.nodeModules, target, { recursive: true, dereference: false });
  return 'copy';
}

/**
 * Can this machine make directory junctions without elevation?
 *
 * @param cacheRoot Somewhere writable to try it in.
 * @returns `junction` when the probe worked, `copy` otherwise.
 */
function probeLinkMode(cacheRoot: string): 'junction' | 'copy' {
  const probeTarget = `${cacheRoot}/.probe-target`;
  const probeLink = `${cacheRoot}/.probe-link`;
  try {
    mkdirSync(probeTarget, { recursive: true });
    rmSync(probeLink, { recursive: true, force: true });
    symlinkSync(probeTarget, probeLink, 'junction');
    return 'junction';
  } catch {
    return 'copy';
  } finally {
    rmSync(probeLink, { recursive: true, force: true });
    rmSync(probeTarget, { recursive: true, force: true });
  }
}

/**
 * npm's own entry script, so npm is never spawned as `npm`.
 *
 * On Windows `npm` is a `.cmd` shim and node refuses to spawn one without a
 * shell; the CLI package solves it the same way.
 *
 * @returns Absolute path to `npm-cli.js`.
 */
export function npmCli(): string {
  const fromExec = toPosix(
    join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  );
  if (existsSync(fromExec)) return fromExec;
  const fromLib = toPosix(
    join(dirname(process.execPath), 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  );
  if (existsSync(fromLib)) return fromLib;
  throw new Error('could not find npm-cli.js next to the node executable');
}

/**
 * Read a file from a game directory, returning undefined rather than throwing.
 *
 * @param gameDir The game.
 * @param relative A game-relative, forward-slashed path.
 * @returns The contents, or undefined when the file is not there.
 */
export function readGameFile(gameDir: string, relative: string): string | undefined {
  try {
    return readFileSync(join(gameDir, relative), 'utf8');
  } catch {
    return undefined;
  }
}

/**
 * Write a file into a game directory, creating parents.
 *
 * The caller must have run the path through `safePath` first; this function
 * does no validation of its own on purpose, so there is exactly one place that
 * decides what a model is allowed to write.
 *
 * @param gameDir The game.
 * @param relative A game-relative, forward-slashed path.
 * @param content What to write.
 * @returns Nothing.
 */
export function writeGameFile(gameDir: string, relative: string, content: string): void {
  const abs = join(gameDir, relative);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content, 'utf8');
}
