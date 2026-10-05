/**
 * `gameable build` — the shipping path.
 *
 * Six steps, in this order:
 *
 * 1. `jco guest-types` into `.gameable/guest-types`, so `tsc` can see the
 *    ambient `gameable:engine/*@0.2.0` declarations.
 * 2. `tsc --noEmit -p tsconfig.json`. A type error must fail here, not thirty
 *    seconds later inside QuickJS.
 * 3. generate `.gameable/entry.ts` and componentize it to
 *    `.gameable/game.wasm`.
 * 4. `wasm-opt -Oz`, under `--release`, when `binaryen` is resolvable.
 * 5. `jco transpile` into `dist/guest`.
 * 6. `vite build` with `GAMEABLE_WASM=1`.
 * 7. for a game that declares `features.multiplayer`, the room server's
 *    bundle: `dist/server/game.json`, its manifest and the level's colliders
 *    (`writeServerBundle`), which `gameable serve` reads beside `dist/guest`.
 *
 * `--no-wasm` stops after step 6's Vite build, with no guest pipeline and no
 * `GAMEABLE_WASM`, which is what a direct-mode preview build wants.
 */
import { existsSync } from 'node:fs';

import { flagBool, flagNumber, parseArgs } from '../lib/args.js';
import { color, mark } from '../lib/colors.js';
import {
  GuestBuildError,
  generateGuestTypes,
  guestBuild,
  resolveToolchain,
} from '../lib/guestBuild.js';
import { absPosix, resolvePackageFile } from '../lib/paths.js';
import { runNode } from '../lib/run.js';
import { writeServerBundle } from '../lib/serverBundle.js';
import {
  DEFAULT_GATES,
  checkGates,
  formatReport,
  measure,
  type ReportGates,
} from '../lib/report.js';

/** Options `gameable build` accepts. */
export const BUILD_SPEC = {
  boolean: ['release', 'report', 'wasm', 'gate', 'help'],
  value: ['ticks'],
  alias: { h: 'help', r: 'release' },
} as const;

/** One screen of help. */
export const BUILD_HELP = `
${color.bold('gameable build')} — componentize the guest and build the site

  --release        run wasm-opt -Oz over the transpiled core modules
  --report         print size and timing numbers, and enforce the budgets
  --no-wasm        skip the guest pipeline; build the site in direct mode
  --no-gate        with --report, print the numbers but never fail on them
  --ticks <n>      ticks to time for --report (default 1000)

Run it in a game directory. Outputs land in .gameable/ and dist/.
`.trim();

/**
 * Run the build.
 *
 * @param argv Arguments after `build`.
 * @param cwd The game directory.
 * @returns The process exit code.
 */
export async function buildCommand(argv: readonly string[], cwd: string): Promise<number> {
  const { flags, unknown } = parseArgs(argv, BUILD_SPEC);
  if (unknown.length > 0) {
    console.error(`${mark.fail} unknown option: ${unknown.join(', ')}`);
    console.error(BUILD_HELP);
    return 1;
  }
  if (flagBool(flags, 'help', false)) {
    console.log(BUILD_HELP);
    return 0;
  }

  const gameDir = absPosix(cwd);
  const wantWasm = flagBool(flags, 'wasm', true);
  const release = flagBool(flags, 'release', false);
  const wantReport = flagBool(flags, 'report', false);
  const gate = flagBool(flags, 'gate', true);
  const ticks = flagNumber(flags, 'ticks', 1000);
  const workDir = `${gameDir}/.gameable`;

  if (!existsSync(`${gameDir}/package.json`)) {
    console.error(`${mark.fail} ${gameDir} has no package.json. Run this inside a game directory.`);
    return 1;
  }

  let wasmPath = `${workDir}/game.wasm`;
  let guestDir = `${gameDir}/dist/guest`;

  if (wantWasm) {
    try {
      const toolchain = resolveToolchain(gameDir);
      console.log(`${mark.step}jco guest-types`);
      await generateGuestTypes(toolchain, `${workDir}/guest-types`);

      const typecheckCode = await typecheck(gameDir);
      if (typecheckCode !== 0) return typecheckCode;

      console.log(`${mark.step}componentize${release ? ' (release)' : ''}`);
      const result = await guestBuild({
        gameDir,
        release,
        force: true,
        skipGuestTypes: true,
        onLog: (line) => {
          console.log(color.gray(`    ${line}`));
        },
      });
      wasmPath = result.wasmPath;
      guestDir = result.guestDir;
      console.log(
        `${mark.ok}guest built in ${(result.durationMs / 1000).toFixed(1)} s -> ${color.cyan(
          guestDir,
        )}`,
      );
    } catch (err) {
      reportBuildError(err);
      return 1;
    }
  } else {
    console.log(`${color.yellow('warn')} --no-wasm: building the site without a guest component`);
  }

  const viteCode = await viteBuild(gameDir, wantWasm);
  if (viteCode !== 0) return viteCode;
  // After the site build: Vite empties dist/, and the bundle lives in dist/server.
  const serverCode = await serverBundle(gameDir);
  if (serverCode !== 0) return serverCode;

  if (!wantReport) return 0;

  try {
    console.log(`${mark.step}measuring (brotli-11 and ${String(ticks)} ticks)`);
    const numbers = await measure({ wasmPath, guestDir, ticks });
    const gates: ReportGates = DEFAULT_GATES;
    console.log('');
    console.log(color.bold('report'));
    console.log(formatReport(numbers, gates));
    console.log('');

    const failures = checkGates(numbers, gates);
    if (failures.length === 0) {
      console.log(`${mark.ok}within budget`);
      return 0;
    }
    for (const failure of failures) console.log(`${mark.fail} ${failure}`);
    if (!gate) {
      console.log(color.yellow('--no-gate: not failing the build'));
      return 0;
    }
    return 1;
  } catch (err) {
    console.error(
      `${mark.fail} report failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return 1;
  }
}

/**
 * Run the game's own `tsc --noEmit`.
 *
 * @param gameDir Absolute game directory.
 * @returns 0 when the game typechecks or has no tsconfig, 1 otherwise.
 */
async function typecheck(gameDir: string): Promise<number> {
  const tsconfig = `${gameDir}/tsconfig.json`;
  if (!existsSync(tsconfig)) {
    console.log(`${mark.warn} no tsconfig.json; skipping the typecheck`);
    return 0;
  }
  const tsc = resolvePackageFile(gameDir, 'typescript', 'bin/tsc');
  if (tsc === undefined) {
    console.log(`${mark.warn} typescript is not installed; skipping the typecheck`);
    return 0;
  }
  console.log(`${mark.step}tsc --noEmit`);
  const result = await runNode(tsc, ['--noEmit', '-p', tsconfig], { cwd: gameDir });
  if (result.status === 0) return 0;
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  console.error(`${mark.fail} typecheck failed`);
  return 1;
}

/**
 * Run the game's own Vite build.
 *
 * @param gameDir Absolute game directory.
 * @param wasm Whether the guest component was built.
 * @returns 0 on success, 1 otherwise.
 */
async function viteBuild(gameDir: string, wasm: boolean): Promise<number> {
  // A fixture or a headless guest has no page to build. Vite would fail with
  // UNRESOLVED_ENTRY, which is a confusing way to say "there is nothing here".
  const hasSite =
    existsSync(`${gameDir}/index.html`) ||
    ['ts', 'js', 'mjs'].some((ext) => existsSync(`${gameDir}/vite.config.${ext}`));
  if (!hasSite) {
    console.log(`${mark.warn} no index.html or vite.config; skipping the site build`);
    return 0;
  }

  const vite = resolvePackageFile(gameDir, 'vite', 'bin/vite.js');
  if (vite === undefined) {
    console.log(`${mark.warn} vite is not installed; skipping the site build`);
    return 0;
  }
  console.log(`${mark.step}vite build${wasm ? ' (GAMEABLE_WASM=1)' : ''}`);
  const result = await runNode(vite, ['build'], {
    cwd: gameDir,
    env: wasm ? { GAMEABLE_WASM: '1' } : {},
    inherit: true,
  });
  if (result.status === 0) return 0;
  console.error(`${mark.fail} vite build failed`);
  return 1;
}

/**
 * Write the room server's bundle, for a game that declares multiplayer.
 *
 * @param gameDir Absolute game directory.
 * @returns 0 when written or not needed, 1 when it failed.
 */
async function serverBundle(gameDir: string): Promise<number> {
  // The game is read through its own Vite: a headless guest or a fixture has neither.
  if (!existsSync(`${gameDir}/src/game.ts`) || resolvePackageFile(gameDir, 'vite', 'dist/node/index.js') === undefined) {
    return 0;
  }
  try {
    if (await writeServerBundle(gameDir)) console.log(`${mark.ok}room server bundle -> ${color.cyan('dist/server')}`);
    return 0;
  } catch (err) {
    console.error(`${mark.fail} room server bundle: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}

/**
 * Print a pipeline failure with its child-process output.
 *
 * @param err Whatever the pipeline threw.
 */
function reportBuildError(err: unknown): void {
  if (err instanceof GuestBuildError) {
    console.error(`${mark.fail} ${err.step}: ${err.message}`);
    if (err.output.length > 0) console.error(err.output);
    return;
  }
  console.error(`${mark.fail} ${err instanceof Error ? err.message : String(err)}`);
}
