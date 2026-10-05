/**
 * The guest build pipeline, extracted from `fixtures/tiny-game/scripts/build.mjs`
 * so `gameable build`, `gameable/vite` and `create-gameable`
 * all run the identical steps.
 *
 * Five stages, every path absolute and forward-slashed:
 *
 * 1. **guest types.** `jco guest-types` writes the ambient `declare module`
 *    blocks for `gameable:engine/*@0.2.0` into `.gameable/guest-types`, so the
 *    game's own `tsc` can see them.
 * 2. **generate the entry.** `jco componentize` compiles exactly one module,
 *    and that module must import the versioned `gameable:engine/*` specifiers. The
 *    build writes a four-line `.gameable/entry.ts` that pulls in the SDK's
 *    entry factory and the game's default export. The game never mentions WIT.
 * 3. **componentize.** `jco componentize --backend qjs
 *    --backend-qjs-disable-async`. TypeScript is bundled by rolldown, so the
 *    entry, the SDK sources and bitecs all come along. Red `UNRESOLVED_IMPORT`
 *    warnings are expected: componentize resolves those itself, after the
 *    bundle. A generated `--bundle-config` aliases `gameable` onto the
 *    SDK sources, because rolldown runs with `platform: "neutral"` and never
 *    applies the workspace `gameable-source` export condition.
 * 4. **transpile.** `jco transpile --instantiation async --no-nodejs-compat`
 *    emits the core wasm files plus `game.js`, whose `instantiate` the host
 *    calls with the import object. There is no `--map`.
 * 5. **optimise.** `wasm-opt -Oz` over each transpiled core module, when
 *    `binaryen` is resolvable and `--release` was asked for. Binaryen cannot
 *    parse a component, so this happens after transpile, never before.
 */
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';

import {
  absPosix,
  findRepoRoot,
  packageDirOf,
  relativeSpecifier,
  resolvePackageDir,
  resolvePackageFile,
} from './paths.js';
import { filterJcoNoise, runNode } from './run.js';

/**
 * This package's own directory, used as the last resort when resolving jco,
 * the WIT package and binaryen.
 *
 * @returns The absolute, forward-slashed `gameable/cli` directory.
 */
function cliPackageDir(): string {
  return packageDirOf(import.meta.url);
}

/**
 * The first defined result of applying `lookup` to each directory in turn.
 *
 * Resolution order is always the game, then the monorepo it may sit in, then
 * the CLI's own install.
 *
 * @param dirs Directories to try, best first; `undefined` entries are skipped.
 * @param lookup What to try in each directory.
 * @returns The first hit, or `undefined`.
 */
function firstOf(
  dirs: readonly (string | undefined)[],
  lookup: (dir: string) => string | undefined,
): string | undefined {
  for (const dir of dirs) {
    if (dir === undefined) continue;
    const hit = lookup(dir);
    if (hit !== undefined) return hit;
  }
  return undefined;
}

/** Where the pipeline looks for things, once resolved. */
export interface GuestToolchain {
  /** `jco`'s entry module. */
  readonly jco: string;
  /** The authored WIT package directory. */
  readonly wit: string;
  /**
   * Where the SDK code lives: the `packages/sdk` workspace (TypeScript
   * sources) inside the engine repository, else the installed `gameable`
   * package (its build).
   */
  readonly sdkDir: string;
  /** The SDK's WIT entry factory module. */
  readonly sdkEntry: string;
  /** `wasm-opt`, when `binaryen` is resolvable. */
  readonly wasmOpt: string | undefined;
}

/** Everything {@link guestBuild} accepts. */
export interface GuestBuildOptions {
  /** Absolute path to the game directory. */
  readonly gameDir: string;
  /** The module whose default export is the `defineGame` result. */
  readonly entry?: string;
  /** Scratch directory for generated files. Defaults to `<gameDir>/.gameable`. */
  readonly workDir?: string;
  /** Where the transpiled guest lands. Defaults to `<gameDir>/dist/guest`. */
  readonly guestDir?: string;
  /** Run `wasm-opt -Oz` over the transpiled core modules. */
  readonly release?: boolean;
  /** Rebuild even when nothing changed. */
  readonly force?: boolean;
  /** Override the WIT package directory. */
  readonly witDir?: string;
  /** Skip `jco guest-types`, when the caller has already run it. */
  readonly skipGuestTypes?: boolean;
  /** Called with each progress line. Defaults to `console.log`. */
  readonly onLog?: (line: string) => void;
}

/** What {@link guestBuild} produced. */
export interface GuestBuildResult {
  /** False when the outputs were already newer than every input. */
  readonly built: boolean;
  /** The component, before transpile. */
  readonly wasmPath: string;
  /** Directory holding the transpiled guest. */
  readonly guestDir: string;
  /** The module exporting `instantiate`. */
  readonly guestEntry: string;
  /** Size of the component in bytes. */
  readonly wasmBytes: number;
  /** Whether `wasm-opt` ran. */
  readonly optimised: boolean;
  /** Wall-clock duration in milliseconds. */
  readonly durationMs: number;
  /** The toolchain that was used. */
  readonly toolchain: GuestToolchain;
}

/** A pipeline step that failed, with the child process output attached. */
export class GuestBuildError extends Error {
  /** The step that failed, for example `componentize`. */
  readonly step: string;
  /** Filtered child-process output. */
  readonly output: string;

  /**
   * Build a pipeline failure.
   *
   * @param step Which stage failed.
   * @param message What went wrong.
   * @param output Child-process output, already filtered.
   */
  constructor(step: string, message: string, output = '') {
    super(message);
    this.name = 'GuestBuildError';
    this.step = step;
    this.output = output;
  }
}

/**
 * Locate jco, the WIT package, the SDK and (optionally) binaryen.
 *
 * Resolution is deliberately layered: an explicit override, then the game's own
 * `node_modules`, then the monorepo the game may be sitting inside, then the
 * CLI's own copy. A published game resolves everything from its dependencies; a
 * workspace member inside this repository resolves everything from the root.
 *
 * @param gameDir Absolute, forward-slashed game directory.
 * @param witOverride Explicit WIT directory, when the caller has one.
 * @returns The resolved toolchain.
 * @throws {GuestBuildError} When jco, the WIT package or the SDK is missing.
 */
export function resolveToolchain(gameDir: string, witOverride?: string): GuestToolchain {
  const here = cliPackageDir();
  const repoRoot = findRepoRoot(gameDir) ?? findRepoRoot(here);

  const jco = firstOf([gameDir, repoRoot, here], (dir) =>
    resolvePackageFile(dir, '@bytecodealliance/jco', 'dist/jco.js'),
  );
  if (jco === undefined) {
    throw new GuestBuildError(
      'resolve',
      'cannot find @bytecodealliance/jco. Run `npm install --save-dev @bytecodealliance/jco componentize-qjs` in the game directory.',
    );
  }

  const installed = resolvePackageDir(gameDir, 'gameable');
  const gameableDir = installed === undefined ? undefined : absPosix(realpathSync(installed));
  // Inside the engine repository (the game is in it, or `gameable` is linked
  // from it) the guest is built from the SDK's sources, never a stale build.
  const sourceSdk = [
    gameableDir === undefined ? undefined : absPosix(`${gameableDir}/../sdk`),
    repoRoot === undefined ? undefined : `${repoRoot}/packages/sdk`,
  ].find((dir) => dir !== undefined && existsSync(`${dir}/src/wit/entry.ts`));
  const builtSdk =
    gameableDir !== undefined && existsSync(`${gameableDir}/dist/sdk-wit-entry.js`)
      ? gameableDir
      : undefined;
  const sdkDir = sourceSdk ?? builtSdk;
  if (sdkDir === undefined) {
    throw new GuestBuildError(
      'resolve',
      'cannot find gameable. Run `npm install gameable` in the game directory.',
    );
  }

  const wit = witOverride ?? findWit(gameDir, gameableDir ?? sdkDir, repoRoot, here);
  if (wit === undefined) {
    throw new GuestBuildError(
      'resolve',
      'cannot find the gameable:engine WIT package. Expected it at <game>/wit, in gameable/wit, or in the engine repository.',
    );
  }

  const wasmOpt = firstOf([gameDir, repoRoot, here], (dir) =>
    resolvePackageFile(dir, 'binaryen', 'bin/wasm-opt'),
  );

  return {
    jco,
    wit,
    sdkDir,
    sdkEntry:
      sourceSdk === undefined ? `${sdkDir}/dist/sdk-wit-entry.js` : `${sdkDir}/src/wit/entry.ts`,
    wasmOpt,
  };
}

/**
 * Find the authored `wit/` package.
 *
 * @param gameDir Absolute game directory.
 * @param packageDir Absolute `gameable` directory (the SDK's, when not installed).
 * @param repoRoot The engine repository root, when the game is inside one.
 * @param cliDir The CLI package's own directory.
 * @returns The absolute WIT directory, or `undefined`.
 */
function findWit(
  gameDir: string,
  packageDir: string,
  repoRoot: string | undefined,
  cliDir: string,
): string | undefined {
  const candidates = [
    process.env.GAMEABLE_WIT,
    `${gameDir}/wit`,
    `${packageDir}/wit`,
    repoRoot === undefined ? undefined : `${repoRoot}/wit`,
    // The CLI's own package: `gameable` ships wit/ beside dist/.
    `${cliDir}/wit`,
  ];
  for (const candidate of candidates) {
    if (candidate !== undefined && existsSync(`${candidate}/world.wit`)) return candidate;
  }
  return undefined;
}

/**
 * The generated componentize entry.
 *
 * Relative specifiers, not absolute ones: rolldown resolves them from the
 * generated file's own directory, and relative paths keep working when the
 * game moves. Extensions are omitted because rolldown resolves `./x` to
 * `./x.ts` and TypeScript would reject an explicit `.ts`.
 *
 * @param workDir Absolute directory the entry is written into.
 * @param sdkEntry Absolute path to the SDK's WIT entry factory.
 * @param gameEntry Absolute path to the game module.
 * @returns The entry source.
 */
export function entrySource(workDir: string, sdkEntry: string, gameEntry: string): string {
  const sdk = relativeSpecifier(workDir, sdkEntry).replace(/\.tsx?$/, '');
  const game = relativeSpecifier(workDir, gameEntry).replace(/\.tsx?$/, '');
  return [
    '// GENERATED by @gameable/cli — do not edit.',
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
 * Every SDK export that has a `gameable-source` target, mapped onto the SDK
 * sources under both of its names: the public one games import (`gameable`,
 * `gameable/sdk/prelude`) and the workspace one engine code imports
 * (`gameable`, `gameable/sdk/prelude`).
 *
 * rolldown bundles with `platform: "neutral"`, so the workspace `gameable-source`
 * condition never applies and `gameable` would resolve to `dist/`, which
 * may not exist. Reading the exports map rather than hard-coding the subpaths
 * keeps the alias correct when the SDK grows one.
 *
 * @param sdkDir Absolute `packages/sdk` directory.
 * @returns Specifier to absolute source file, longest specifier first.
 */
export function sdkAliases(sdkDir: string): Record<string, string> {
  const manifest = JSON.parse(readFileSync(`${sdkDir}/package.json`, 'utf8')) as {
    exports?: Record<string, unknown>;
  };
  const exportsMap = manifest.exports ?? {};
  const aliases: Record<string, string> = {};

  for (const [subpath, target] of Object.entries(exportsMap)) {
    if (!subpath.startsWith('.')) continue;
    const rel = pickSourceTarget(target);
    if (rel === undefined || !rel.endsWith('.ts')) continue;
    const tail = subpath.slice(1);
    const names =
      subpath === '.'
        ? ['gameable', '@gameable/sdk']
        : [`gameable/sdk${tail}`, `@gameable/sdk${tail}`];
    for (const name of names) aliases[name] = `${sdkDir}/${rel.replace(/^\.\//, '')}`;
  }

  return Object.fromEntries(
    Object.entries(aliases).sort(([a], [b]) => b.length - a.length || (a < b ? -1 : 1)),
  );
}

/**
 * Pull the `gameable-source` (or plain string) target out of one exports entry: the repository's
 * own condition for a package's TypeScript sources (not `development`, which Vite turns on in
 * every dev server, so an app installing the packages would resolve to sources they do not ship).
 *
 * @param target An exports-map value.
 * @returns The relative target, or `undefined` when there is no TypeScript one.
 */
function pickSourceTarget(target: unknown): string | undefined {
  if (typeof target === 'string') return target;
  if (typeof target !== 'object' || target === null) return undefined;
  const conditions = target as Record<string, unknown>;
  const source = conditions['gameable-source'];
  if (typeof source === 'string') return source;
  return undefined;
}

/**
 * The generated rolldown configuration handed to `--bundle-config`.
 *
 * @param aliases Specifier to absolute source file.
 * @returns The config module source.
 */
export function bundleConfigSource(aliases: Readonly<Record<string, string>>): string {
  const lines = Object.entries(aliases).map(
    ([specifier, target]) => `      '${specifier}': '${target}',`,
  );
  return [
    '// GENERATED by @gameable/cli — do not edit.',
    '// rolldown takes `resolve.alias` as a plain record, not the Vite array',
    '// form; longer keys are listed first so subpaths win over the bare name.',
    'export default {',
    '  resolve: {',
    '    alias: {',
    ...lines,
    '    },',
    '  },',
    '};',
    '',
  ].join('\n');
}

/**
 * Newest mtime under a path, recursively, ignoring build output.
 *
 * @param path Absolute file or directory.
 * @returns Milliseconds since the epoch, or 0 when the path is absent.
 */
export function newestMtime(path: string): number {
  if (!existsSync(path)) return 0;
  const stat = statSync(path);
  if (!stat.isDirectory()) return stat.mtimeMs;
  let max = stat.mtimeMs;
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === '.gameable') {
      continue;
    }
    max = Math.max(max, newestMtime(`${path}/${entry.name}`));
  }
  return max;
}

/**
 * Write a file only when its contents would change, so mtimes stay meaningful.
 *
 * @param path Absolute file path.
 * @param text Desired contents.
 */
function writeIfChanged(path: string, text: string): void {
  if (existsSync(path) && readFileSync(path, 'utf8') === text) return;
  writeFileSync(path, text, 'utf8');
}

/**
 * Total size in bytes of every file directly inside a directory tree.
 *
 * @param dir Absolute directory.
 * @returns Bytes, or 0 when the directory is absent.
 */
export function directorySize(dir: string): number {
  if (!existsSync(dir)) return 0;
  let total = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const child = `${dir}/${entry.name}`;
    total += entry.isDirectory() ? directorySize(child) : statSync(child).size;
  }
  return total;
}

/**
 * Generate the ambient `gameable:engine/*` declarations for the game's `tsc`.
 *
 * @param toolchain Resolved jco and WIT locations.
 * @param outDir Absolute output directory.
 * @returns Nothing.
 * @throws {GuestBuildError} When jco fails.
 */
export async function generateGuestTypes(toolchain: GuestToolchain, outDir: string): Promise<void> {
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  const result = await runNode(toolchain.jco, [
    'guest-types',
    toolchain.wit,
    '--world-name',
    'game-module',
    '--name',
    'wit',
    '-o',
    outDir,
    '--quiet',
  ]);
  if (result.status !== 0) {
    throw new GuestBuildError(
      'guest-types',
      `jco guest-types failed with status ${String(result.status)}`,
      filterJcoNoise(`${result.stdout}${result.stderr}`),
    );
  }
}

/**
 * Build the game's WebAssembly component and transpile it for the browser.
 *
 * @param options Game directory and pipeline overrides.
 * @returns Where the outputs landed and what they cost.
 * @throws {GuestBuildError} When any stage fails.
 */
export async function guestBuild(options: GuestBuildOptions): Promise<GuestBuildResult> {
  const started = Date.now();
  const gameDir = absPosix(options.gameDir);
  const log =
    options.onLog ??
    ((line: string): void => {
      console.log(line);
    });

  const gameEntry = absPosix(options.entry ?? `${gameDir}/src/game.ts`);
  const workDir = absPosix(options.workDir ?? `${gameDir}/.gameable`);
  const guestDir = absPosix(options.guestDir ?? `${gameDir}/dist/guest`);
  const wasmPath = `${workDir}/game.wasm`;
  const guestEntry = `${guestDir}/game.js`;

  if (!existsSync(gameEntry)) {
    throw new GuestBuildError('resolve', `game entry not found: ${gameEntry}`);
  }

  const toolchain = resolveToolchain(gameDir, options.witDir);

  const inputs = [
    `${gameDir}/src`,
    `${toolchain.sdkDir}/src`,
    `${toolchain.sdkDir}/dist`,
    toolchain.wit,
  ];
  const newestInput = inputs.reduce((max, path) => Math.max(max, newestMtime(path)), 0);
  const builtAt = newestMtime(guestEntry);
  if (options.force !== true && builtAt > 0 && builtAt >= newestInput) {
    return {
      built: false,
      wasmPath,
      guestDir,
      guestEntry,
      wasmBytes: existsSync(wasmPath) ? statSync(wasmPath).size : 0,
      optimised: false,
      durationMs: Date.now() - started,
      toolchain,
    };
  }

  mkdirSync(workDir, { recursive: true });

  if (options.skipGuestTypes !== true) {
    log('guest types');
    await generateGuestTypes(toolchain, `${workDir}/guest-types`);
  }

  const entryPath = `${workDir}/entry.ts`;
  const configPath = `${workDir}/rolldown.config.mjs`;
  writeIfChanged(entryPath, entrySource(workDir, toolchain.sdkEntry, gameEntry));
  writeIfChanged(
    configPath,
    bundleConfigSource(toolchain.sdkEntry.endsWith('.js') ? {} : sdkAliases(toolchain.sdkDir)),
  );

  log('componentize (about 30 s)');
  const componentize = await runNode(toolchain.jco, [
    'componentize',
    '--backend',
    'qjs',
    '--backend-qjs-disable-async',
    '-n',
    'game-module',
    '--wit',
    toolchain.wit,
    '--bundle-config',
    configPath,
    '-o',
    wasmPath,
    entryPath,
  ]);
  const componentizeOutput = filterJcoNoise(`${componentize.stdout}${componentize.stderr}`).trim();
  if (componentize.status !== 0) {
    throw new GuestBuildError(
      'componentize',
      `jco componentize failed with status ${String(componentize.status)}`,
      componentizeOutput,
    );
  }
  if (componentizeOutput.length > 0) log(componentizeOutput);

  log('transpile');
  rmSync(guestDir, { recursive: true, force: true });
  const transpile = await runNode(toolchain.jco, [
    'transpile',
    wasmPath,
    '--instantiation',
    'async',
    '--no-nodejs-compat',
    '--name',
    'game',
    '-o',
    guestDir,
    '--quiet',
  ]);
  if (transpile.status !== 0) {
    throw new GuestBuildError(
      'transpile',
      `jco transpile failed with status ${String(transpile.status)}`,
      filterJcoNoise(`${transpile.stdout}${transpile.stderr}`),
    );
  }

  let optimised = false;
  if (options.release === true) {
    if (toolchain.wasmOpt === undefined) {
      log('wasm-opt skipped: binaryen is not installed');
    } else {
      optimised = await optimiseCoreModules(toolchain.wasmOpt, guestDir, log);
    }
  }

  return {
    built: true,
    wasmPath,
    guestDir,
    guestEntry,
    wasmBytes: statSync(wasmPath).size,
    optimised,
    durationMs: Date.now() - started,
    toolchain,
  };
}

/**
 * Run `wasm-opt -Oz` over every transpiled core module.
 *
 * Binaryen cannot parse a WebAssembly **component** — it says so, loudly — so
 * the component itself is left alone and the core modules jco unpacked from it
 * are optimised instead. That is the only shape that reaches the browser.
 *
 * @param wasmOpt Absolute path to binaryen's `wasm-opt` script.
 * @param guestDir Directory holding the transpiled guest.
 * @param log Progress sink.
 * @returns True when at least one module was rewritten.
 */
async function optimiseCoreModules(
  wasmOpt: string,
  guestDir: string,
  log: (line: string) => void,
): Promise<boolean> {
  const modules = readdirSync(guestDir).filter((name) => name.endsWith('.wasm'));
  let before = 0;
  let after = 0;
  let any = false;

  for (const name of modules) {
    const path = `${guestDir}/${name}`;
    const temp = `${path}.opt`;
    const originalBytes = statSync(path).size;
    const result = await runNode(wasmOpt, ['-Oz', '--all-features', path, '-o', temp]);
    if (result.status !== 0 || !existsSync(temp)) {
      rmSync(temp, { force: true });
      const why = result.stderr.trim().split('\n').at(0) ?? 'failed';
      log(`wasm-opt skipped ${name}: ${why}`);
      before += originalBytes;
      after += originalBytes;
      continue;
    }
    cpSync(temp, path);
    rmSync(temp, { force: true });
    before += originalBytes;
    after += statSync(path).size;
    any = true;
  }

  if (any) {
    const saved = before - after;
    log(
      `wasm-opt -Oz: ${String(modules.length)} core modules, ${(saved / 1024).toFixed(1)} KiB saved`,
    );
  }
  return any;
}
