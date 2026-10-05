/**
 * `gameable doctor` — everything that can be wrong before you have even run
 * the game, with a copy-pasteable fix for each.
 *
 * The checks take their filesystem, child processes and module resolution from
 * a {@link DoctorDeps} record, so the whole suite runs under vitest with fakes
 * and no toolchain at all. The exit code is the number of failures; warnings
 * never fail.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname } from 'node:path';

import { flagBool, parseArgs } from '../lib/args.js';
import { color, mark } from '../lib/colors.js';
import { absPosix, findRepoRoot, packageDirOf, resolvePackageDir } from '../lib/paths.js';
import { run, type Runner } from '../lib/run.js';

/** How one check turned out. */
export type CheckStatus = 'ok' | 'warn' | 'fail';

/** The result of a single check. */
export interface CheckResult {
  /** Short label, for example `node`. */
  readonly name: string;
  /** Whether this blocks, warns, or passes. */
  readonly status: CheckStatus;
  /** One line of detail. */
  readonly detail: string;
  /** A command or edit that fixes it, when there is one. */
  readonly fix?: string;
}

/** Everything the checks touch, injectable so tests need no toolchain. */
export interface DoctorDeps {
  /** Absolute, forward-slashed game directory. */
  readonly cwd: string;
  /** Child-process runner. */
  readonly run: Runner;
  /** Does this path exist? */
  readonly exists: (path: string) => boolean;
  /** Read a UTF-8 file. May throw. */
  readFile(path: string): string;
  /** `process.versions.node`. */
  readonly nodeVersion: string;
  /** `process.platform`. */
  readonly platform: string;
  /** `process.arch`. */
  readonly arch: string;
  /** Resolve an installed package's own directory. */
  readonly resolveDir: (fromDir: string, name: string) => string | undefined;
  /** npm's own CLI entry point, when one can be found. */
  readonly npmCli: string | undefined;
  /** Validate an `assets.json` document. Throws on an invalid manifest. */
  readonly parseManifest: (json: unknown) => ParsedManifest;
}

/** The shape of a manifest, as far as the doctor cares. */
export interface ParsedManifest {
  /** Prefix joined to every relative `src`. */
  readonly baseUrl: string;
  /** Every asset the game can reference. */
  readonly assets: readonly {
    readonly id: string;
    readonly src: string;
    readonly collider?: { readonly src?: string };
    readonly rig?: { readonly pack?: string };
  }[];
}

/** Options `gameable doctor` accepts. */
export const DOCTOR_SPEC = {
  boolean: ['help', 'quiet'],
  alias: { h: 'help', q: 'quiet' },
} as const;

/** One screen of help. */
export const DOCTOR_HELP = `
${color.bold('gameable doctor')} — check the toolchain and the game

  --quiet          print only warnings and failures

Exit code is the number of failed checks. Warnings do not fail.
`.trim();

/** Minimum versions the engine requires. */
export const MINIMUM = { node: 24, npm: 11 } as const;

/**
 * Locate npm's own JavaScript entry point.
 *
 * Spawning `npm` directly is not an option: on Windows it is a `.cmd` shim, and
 * node refuses to spawn those without a shell. npm's CLI is a plain script, so
 * the doctor runs `node npm-cli.js` instead.
 *
 * @returns The absolute path, or `undefined` when npm cannot be found.
 */
export function findNpmCli(): string | undefined {
  const fromEnv = process.env.npm_execpath;
  if (fromEnv !== undefined && fromEnv.endsWith('.js') && existsSync(fromEnv)) {
    return fromEnv.replaceAll('\\', '/');
  }
  const nodeDir = dirname(process.execPath).replaceAll('\\', '/');
  for (const candidate of [
    `${nodeDir}/node_modules/npm/bin/npm-cli.js`,
    `${nodeDir}/../lib/node_modules/npm/bin/npm-cli.js`,
  ]) {
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

/**
 * The default dependency set: the real filesystem and the real toolchain.
 *
 * @param cwd The game directory.
 * @returns Dependencies wired to this process.
 */
export function realDeps(cwd: string): DoctorDeps {
  return {
    cwd: absPosix(cwd),
    run,
    exists: existsSync,
    readFile: (path: string) => readFileSync(path, 'utf8'),
    nodeVersion: process.versions.node,
    platform: process.platform,
    arch: process.arch,
    resolveDir: resolvePackageDir,
    npmCli: findNpmCli(),
    parseManifest: (json: unknown) => json as ParsedManifest,
  };
}

/**
 * Compare a dotted version against a required major.
 *
 * @param version A version string, with or without a leading `v`.
 * @param major The minimum acceptable major version.
 * @returns True when the version is at least that major.
 */
export function meetsMajor(version: string, major: number): boolean {
  const parsed = Number.parseInt(version.replace(/^v/, '').split('.')[0] ?? '', 10);
  return Number.isFinite(parsed) && parsed >= major;
}

/**
 * The napi binding package `componentize-qjs` needs on this machine.
 *
 * @param platform `process.platform`.
 * @param arch `process.arch`.
 * @returns The optional-dependency package name.
 */
export function componentizeBinding(platform: string, arch: string): string {
  const suffix = platform === 'win32' ? '-msvc' : platform === 'linux' ? '-gnu' : '';
  return `@andreiltd/componentize-qjs-binding-${platform}-${arch}${suffix}`;
}

/**
 * Every `three` version present in an `npm ls three --json` document.
 *
 * @param tree The parsed npm output.
 * @returns Distinct versions, sorted.
 */
export function threeVersions(tree: unknown): string[] {
  const found = new Set<string>();

  /**
   * Walk one dependency node.
   *
   * @param node A node of the npm tree.
   * @param name The key this node was found under.
   */
  function visit(node: unknown, name: string): void {
    if (typeof node !== 'object' || node === null) return;
    const record = node as { version?: unknown; dependencies?: unknown };
    if (name === 'three' && typeof record.version === 'string') found.add(record.version);
    const deps = record.dependencies;
    if (typeof deps !== 'object' || deps === null) return;
    for (const [key, child] of Object.entries(deps as Record<string, unknown>)) visit(child, key);
  }

  visit(tree, '');
  return [...found].sort();
}

/**
 * Run every check.
 *
 * @param deps Filesystem, child processes and resolution.
 * @returns One result per check, in display order.
 */
export async function runChecks(deps: DoctorDeps): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  results.push(checkNode(deps));
  results.push(await checkNpm(deps));
  results.push(await checkGitLfs(deps));
  results.push(await checkThreeSingleton(deps));
  results.push(...checkManifest(deps));
  results.push(checkWit(deps));
  results.push(...checkJco(deps));
  results.push(checkReservedImports(deps));
  results.push(checkWebGpu(deps));
  return results;
}

/**
 * Node must be 24 or newer.
 *
 * @param deps Doctor dependencies.
 * @returns The check result.
 */
function checkNode(deps: DoctorDeps): CheckResult {
  const ok = meetsMajor(deps.nodeVersion, MINIMUM.node);
  return {
    name: 'node',
    status: ok ? 'ok' : 'fail',
    detail: `v${deps.nodeVersion} (need >= ${String(MINIMUM.node)})`,
    fix: ok ? undefined : 'Install Node 24 or newer: https://nodejs.org/en/download',
  };
}

/**
 * npm must be 11 or newer, for workspaces and `overrides`.
 *
 * @param deps Doctor dependencies.
 * @returns The check result.
 */
async function checkNpm(deps: DoctorDeps): Promise<CheckResult> {
  if (deps.npmCli === undefined) {
    return {
      name: 'npm',
      status: 'warn',
      detail: 'could not find npm-cli.js; skipped',
      fix: 'Check `npm --version` by hand; the engine needs npm >= 11.',
    };
  }
  const result = await deps.run(process.execPath, [deps.npmCli, '--version'], { cwd: deps.cwd });
  const version = result.stdout.trim();
  if (result.status !== 0 || version === '') {
    return { name: 'npm', status: 'warn', detail: 'npm --version failed' };
  }
  const ok = meetsMajor(version, MINIMUM.npm);
  return {
    name: 'npm',
    status: ok ? 'ok' : 'fail',
    detail: `v${version} (need >= ${String(MINIMUM.npm)})`,
    fix: ok ? undefined : 'npm install -g npm@latest',
  };
}

/**
 * Git LFS is optional, and its absence is a warning at most.
 *
 * @param deps Doctor dependencies.
 * @returns The check result.
 */
async function checkGitLfs(deps: DoctorDeps): Promise<CheckResult> {
  const result = await deps.run('git', ['lfs', 'version'], { cwd: deps.cwd });
  if (result.status === 0) {
    return {
      name: 'git lfs',
      status: 'ok',
      detail: result.stdout.trim().split('\n').at(0) ?? 'present',
    };
  }
  return {
    name: 'git lfs',
    status: 'warn',
    detail: 'not installed (only needed for your own large binary assets)',
    fix: 'https://git-lfs.com — the placeholder assets and the templates do not need it.',
  };
}

/**
 * Exactly one copy of `three` must be installed.
 *
 * Two copies means two module singletons, and `instanceof` checks start failing
 * in ways that look like renderer bugs.
 *
 * @param deps Doctor dependencies.
 * @returns The check result.
 */
async function checkThreeSingleton(deps: DoctorDeps): Promise<CheckResult> {
  if (deps.npmCli === undefined) {
    return { name: 'three', status: 'warn', detail: 'npm not found; skipped' };
  }
  const result = await deps.run(process.execPath, [deps.npmCli, 'ls', 'three', '--json', '--all'], {
    cwd: deps.cwd,
  });
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    return { name: 'three', status: 'warn', detail: 'could not parse `npm ls three --json`' };
  }
  const versions = threeVersions(parsed);
  if (versions.length === 0) {
    return { name: 'three', status: 'warn', detail: 'three is not installed here' };
  }
  if (versions.length === 1) {
    return { name: 'three', status: 'ok', detail: `one instance, ${versions[0] ?? ''}` };
  }
  return {
    name: 'three',
    status: 'fail',
    detail: `${String(versions.length)} instances: ${versions.join(', ')}`,
    fix: 'Pin one version in package.json "overrides": { "three": "0.186.0" }, then `rm -rf node_modules package-lock.json && npm install`.',
  };
}

/**
 * `src/assets.json` must parse, and every relative `src` must exist on disk.
 *
 * @param deps Doctor dependencies.
 * @returns One result for the manifest and, when it parsed, one for its files.
 */
function checkManifest(deps: DoctorDeps): CheckResult[] {
  const candidates = [`${deps.cwd}/src/assets.json`, `${deps.cwd}/assets.json`];
  const path = candidates.find((candidate) => deps.exists(candidate));
  if (path === undefined) {
    return [
      {
        name: 'assets.json',
        status: 'warn',
        detail: 'no src/assets.json found',
        fix: 'Every game addresses assets by id. Create src/assets.json with { "version": 1, "assets": [] }.',
      },
    ];
  }

  let manifest: ParsedManifest;
  try {
    manifest = deps.parseManifest(JSON.parse(deps.readFile(path)));
  } catch (err) {
    return [
      {
        name: 'assets.json',
        status: 'fail',
        detail: err instanceof Error ? err.message : String(err),
        fix: `Fix ${path} against docs/schemas/assets.schema.json.`,
      },
    ];
  }

  const missing: string[] = [];
  let aliased = 0;
  for (const entry of manifest.assets) {
    for (const src of [entry.src, entry.collider?.src, entry.rig?.pack]) {
      if (src === undefined || /^[a-z][a-z0-9+.-]*:/i.test(src)) continue;
      // `@placeholder/arena.spz` and friends are resolved by the game at load
      // time, against URLs the bundler minted. There is no file to look for.
      if (src.startsWith('@')) {
        aliased += 1;
        continue;
      }
      if (!resolvesOnDisk(deps, manifest.baseUrl, src)) missing.push(`${entry.id} -> ${src}`);
    }
  }
  const aliasNote = aliased === 0 ? '' : `, ${String(aliased)} resolved at load time`;

  return [
    {
      name: 'assets.json',
      status: 'ok',
      detail: `${String(manifest.assets.length)} entries, valid`,
    },
    missing.length === 0
      ? { name: 'asset files', status: 'ok', detail: `every referenced file exists${aliasNote}` }
      : {
          name: 'asset files',
          status: 'fail',
          detail: `${String(missing.length)} missing: ${missing.slice(0, 4).join(', ')}`,
          fix: 'Put the files under public/ (Vite serves that at the site root), or fix the manifest src.',
        },
  ];
}

/**
 * Does a manifest `src` correspond to a file the dev server will serve?
 *
 * @param deps Doctor dependencies.
 * @param baseUrl The manifest's `baseUrl`.
 * @param src A relative `src`.
 * @returns True when the file exists somewhere Vite will serve it from.
 */
function resolvesOnDisk(deps: DoctorDeps, baseUrl: string, src: string): boolean {
  const joined = `${baseUrl}${baseUrl !== '' && !baseUrl.endsWith('/') ? '/' : ''}${src}`.replace(
    /^\//,
    '',
  );
  const roots = [`${deps.cwd}/public`, deps.cwd, `${deps.cwd}/src`];
  return roots.some((root) => deps.exists(`${root}/${joined}`) || deps.exists(`${root}/${src}`));
}

/**
 * The `gameable:engine` WIT package must be resolvable.
 *
 * @param deps Doctor dependencies.
 * @returns The check result.
 */
function checkWit(deps: DoctorDeps): CheckResult {
  const sdkDir = deps.resolveDir(deps.cwd, 'gameable');
  const repoRoot = findRepoRoot(deps.cwd) ?? findRepoRoot(packageDirOf(import.meta.url));
  const candidates = [
    process.env.GAMEABLE_WIT,
    `${deps.cwd}/wit`,
    sdkDir === undefined ? undefined : `${sdkDir}/wit`,
    repoRoot === undefined ? undefined : `${repoRoot}/wit`,
  ];
  const found = candidates.find(
    (candidate) => candidate !== undefined && deps.exists(`${candidate}/world.wit`),
  );
  if (found !== undefined) {
    return { name: 'wit', status: 'ok', detail: found };
  }
  return {
    name: 'wit',
    status: 'fail',
    detail: 'cannot find the gameable:engine WIT package',
    fix: 'npm install gameable — the WIT package ships with it. Or set GAMEABLE_WIT to a checkout of wit/.',
  };
}

/**
 * jco, componentize-qjs and its native binding must all be installed.
 *
 * @param deps Doctor dependencies.
 * @returns One result per tool.
 */
function checkJco(deps: DoctorDeps): CheckResult[] {
  const results: CheckResult[] = [];

  const jco = deps.resolveDir(deps.cwd, '@bytecodealliance/jco');
  results.push(
    jco === undefined
      ? {
          name: 'jco',
          status: 'fail',
          detail: 'not installed',
          fix: 'npm install --save-dev @bytecodealliance/jco componentize-qjs',
        }
      : { name: 'jco', status: 'ok', detail: versionOf(deps, `${jco}/package.json`) },
  );

  const qjs = deps.resolveDir(deps.cwd, 'componentize-qjs');
  results.push(
    qjs === undefined
      ? {
          name: 'componentize-qjs',
          status: 'fail',
          detail: 'not installed',
          fix: 'npm install --save-dev componentize-qjs',
        }
      : { name: 'componentize-qjs', status: 'ok', detail: versionOf(deps, `${qjs}/package.json`) },
  );

  const binding = componentizeBinding(deps.platform, deps.arch);
  const bindingPath = deps.resolveDir(deps.cwd, binding);
  results.push(
    bindingPath === undefined
      ? {
          name: 'qjs binding',
          status: 'fail',
          detail: `${binding} is missing`,
          fix: `npm install --save-optional ${binding} — or reinstall without --no-optional, which skips every native binding.`,
        }
      : { name: 'qjs binding', status: 'ok', detail: binding },
  );

  return results;
}

/**
 * Read a package's version, tolerating an unreadable manifest.
 *
 * @param deps Doctor dependencies.
 * @param manifestPath Absolute path to a `package.json`.
 * @returns The version, or `installed`.
 */
function versionOf(deps: DoctorDeps, manifestPath: string): string {
  try {
    const json = JSON.parse(deps.readFile(manifestPath)) as { version?: unknown };
    return typeof json.version === 'string' ? `v${json.version}` : 'installed';
  } catch {
    return 'installed';
  }
}

/** Specifiers only the generated componentize entry may import. */
const RESERVED_PREFIX = 'aos:';

/**
 * Game code must not import the reserved `gameable:engine/*` WIT specifiers.
 *
 * Those exist only inside `jco componentize`, and importing one from game code
 * produces a bundle that builds and then traps at instantiation. Everything a
 * game needs is re-exported from `gameable`.
 *
 * @param deps Doctor dependencies.
 * @returns The check result.
 */
function checkReservedImports(deps: DoctorDeps): CheckResult {
  const offenders: string[] = [];
  for (const file of sourceFiles(deps, `${deps.cwd}/src`)) {
    let text: string;
    try {
      text = deps.readFile(file);
    } catch {
      continue;
    }
    for (const match of text.matchAll(/from\s+['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]/g)) {
      const specifier = match.at(1) ?? match.at(2) ?? '';
      if (specifier.startsWith(RESERVED_PREFIX)) {
        offenders.push(`${file.slice(deps.cwd.length + 1)}: ${specifier}`);
      }
    }
  }
  if (offenders.length === 0) {
    return { name: 'wit imports', status: 'ok', detail: 'no reserved aos: specifiers in src/' };
  }
  return {
    name: 'wit imports',
    status: 'fail',
    detail: offenders.slice(0, 4).join('; '),
    fix: "Import from 'gameable' instead. The gameable:engine/* specifiers belong to the generated .gameable/entry.ts, and nothing else.",
  };
}

/**
 * Every source file under a directory, without following `node_modules`.
 *
 * Uses the injected `exists` plus node's own `readdirSync`, so a fake
 * filesystem in a test simply reports no files.
 *
 * @param deps Doctor dependencies.
 * @param dir Absolute directory.
 * @returns Absolute, forward-slashed source paths.
 */
function sourceFiles(deps: DoctorDeps, dir: string): string[] {
  if (!deps.exists(dir)) return [];
  const out: string[] = [];
  const walk = (current: string, depth: number): void => {
    if (depth > 8) return;
    const entries = readdirSafe(current);
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      const child = `${current}/${entry.name}`;
      if (entry.isDirectory()) walk(child, depth + 1);
      else if (/\.(?:ts|tsx|js|mjs)$/.test(entry.name)) out.push(child);
    }
  };
  walk(dir, 0);
  return out;
}

/**
 * `readdirSync` that never throws.
 *
 * Only ever reached when {@link DoctorDeps.exists} said the directory is there,
 * so a fake filesystem in a test never gets here.
 *
 * @param dir Absolute directory.
 * @returns Directory entries, or an empty list.
 */
function readdirSafe(dir: string): { name: string; isDirectory: () => boolean }[] {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

/**
 * WebGPU cannot be probed from node; print the flags that make it work.
 *
 * @param deps Doctor dependencies.
 * @returns The check result.
 */
function checkWebGpu(deps: DoctorDeps): CheckResult {
  const flags =
    deps.platform === 'linux'
      ? '--enable-unsafe-webgpu --enable-features=Vulkan'
      : '--enable-unsafe-webgpu --enable-gpu --ignore-gpu-blocklist';
  return {
    name: 'webgpu',
    status: 'warn',
    detail: 'cannot be probed from node; check chrome://gpu in the browser',
    fix: `Chrome/Edge 121+ renders splats out of the box. For headless or a stubborn GPU: chrome ${flags}`,
  };
}

/**
 * Print the checks and return the number of failures.
 *
 * @param argv Arguments after `doctor`.
 * @param cwd The game directory.
 * @returns The process exit code: the number of failed checks.
 */
export async function doctorCommand(argv: readonly string[], cwd: string): Promise<number> {
  const { flags, unknown } = parseArgs(argv, DOCTOR_SPEC);
  if (unknown.length > 0) {
    console.error(`${mark.fail} unknown option: ${unknown.join(', ')}`);
    console.error(DOCTOR_HELP);
    return 1;
  }
  if (flagBool(flags, 'help', false)) {
    console.log(DOCTOR_HELP);
    return 0;
  }

  const deps = { ...realDeps(cwd), parseManifest: await loadParseManifest() };
  const quiet = flagBool(flags, 'quiet', false);

  console.log(`${color.bold('gameable doctor')} ${color.gray(deps.cwd)}`);
  console.log('');

  const results = await runChecks(deps);
  const width = results.reduce((max, r) => Math.max(max, r.name.length), 0);

  for (const result of results) {
    if (quiet && result.status === 'ok') continue;
    const badge =
      result.status === 'ok' ? mark.ok : result.status === 'warn' ? mark.warn : mark.fail;
    console.log(`  ${badge} ${result.name.padEnd(width)}  ${result.detail}`);
    if (result.fix !== undefined && result.status !== 'ok') {
      console.log(`       ${color.gray(result.fix)}`);
    }
  }

  const failures = results.filter((r) => r.status === 'fail').length;
  const warnings = results.filter((r) => r.status === 'warn').length;
  console.log('');
  console.log(
    failures === 0
      ? `${mark.ok}${String(results.length)} checks, ${String(warnings)} warning(s), no failures`
      : `${mark.fail} ${String(failures)} failure(s), ${String(warnings)} warning(s)`,
  );
  return failures;
}

/**
 * Load `parseManifest` from the game's own `gameable/assets`.
 *
 * The specifier is a variable so neither TypeScript nor rolldown resolves it at
 * build time; if the package is missing the doctor falls back to "it is JSON
 * and that is all I can tell you".
 *
 * @returns A validator.
 */
async function loadParseManifest(): Promise<(json: unknown) => ParsedManifest> {
  const specifier = 'gameable/assets';
  try {
    const mod = (await import(specifier)) as {
      parseManifest: (json: unknown) => ParsedManifest;
    };
    return mod.parseManifest;
  } catch {
    return (json: unknown): ParsedManifest => {
      const record = json as { baseUrl?: unknown; assets?: unknown };
      return {
        baseUrl: typeof record.baseUrl === 'string' ? record.baseUrl : '',
        assets: Array.isArray(record.assets) ? (record.assets as ParsedManifest['assets']) : [],
      };
    };
  }
}
