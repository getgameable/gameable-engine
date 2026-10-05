/**
 * Scoring: five stages, hardest question last.
 *
 * | Stage       | Command                              | Question it answers                    |
 * | ----------- | ------------------------------------ | -------------------------------------- |
 * | `typecheck` | `tsc -p tsconfig.json --noEmit`      | did it use APIs that exist?            |
 * | `unit`      | the template's own vitest            | did it break the game's own rules?     |
 * | `build`     | `gameable build --no-wasm`          | would a player get a playable bundle?  |
 * | `e2e`       | `vite preview` + headless Chromium   | does it boot and draw?                 |
 * | `checks`    | grep assertions from the prompt      | did it do the thing that was asked?    |
 *
 * `build` drops the componentize step by default because `jco componentize` is
 * about thirty seconds and the repository's own parity test already proves the
 * direct and wasm sandboxes agree. `GAMEABLE_LLM_EVAL_WASM=1` runs the full path.
 * `e2e` needs a GPU and a browser download, so it is off unless
 * `GAMEABLE_LLM_EVAL_E2E=1`.
 */
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { run } from './proc.ts';
import type { StageName } from './prompts.ts';

/** How one stage went. */
export type StageStatus = 'pass' | 'fail' | 'skipped';

/** The outcome of one stage. */
export interface StageResult {
  /** Which stage. */
  readonly name: StageName;
  /** Pass, fail, or skipped (not run, and not counted against the model). */
  readonly status: StageStatus;
  /** Wall clock. */
  readonly durationMs: number;
  /** The failure, or why it was skipped. Truncated. */
  readonly detail?: string;
}

/** What the stage runners need to know. */
export interface StageContext {
  /** The game directory, with a linked `node_modules`. */
  readonly gameDir: string;
  /** The engine checkout, for the CLI binary. */
  readonly repoRoot: string;
  /** Stages this prompt opted out of. */
  readonly skip: ReadonlySet<StageName>;
  /** Why, for the skipped stage's detail. */
  readonly skipReason?: string;
}

/** How much of a command's output ends up in the result file. */
const DETAIL_CHARS = 4000;

/**
 * Trim a command's output down to something a scoreboard can carry.
 *
 * @param output The captured stdout/stderr.
 * @returns The last few thousand characters, trimmed.
 */
function detail(output: string): string {
  const trimmed = output.trim();
  return trimmed.length > DETAIL_CHARS ? `…${trimmed.slice(-DETAIL_CHARS)}` : trimmed;
}

/**
 * A stage that was not run.
 *
 * @param name Which stage.
 * @param why The reason, shown in the scoreboard.
 * @returns A skipped result.
 */
function skipped(name: StageName, why: string): StageResult {
  return { name, status: 'skipped', durationMs: 0, detail: why };
}

/**
 * `tsc --noEmit` against the game's own tsconfig.
 *
 * @param ctx Where the game is.
 * @returns The stage result.
 */
export async function stageTypecheck(ctx: StageContext): Promise<StageResult> {
  if (ctx.skip.has('typecheck')) return skipped('typecheck', ctx.skipReason ?? 'opted out');
  const tsc = `${ctx.gameDir}/node_modules/typescript/bin/tsc`;
  if (!existsSync(tsc)) return skipped('typecheck', 'typescript is not installed in the game');
  const result = await run(process.execPath, [tsc, '-p', 'tsconfig.json', '--noEmit'], {
    cwd: ctx.gameDir,
    timeoutMs: 300_000,
  });
  return {
    name: 'typecheck',
    status: result.status === 0 ? 'pass' : 'fail',
    durationMs: result.durationMs,
    detail: result.status === 0 ? undefined : detail(result.output),
  };
}

/**
 * The template's own vitest suite, run in the game directory.
 *
 * @param ctx Where the game is.
 * @returns The stage result.
 */
export async function stageUnit(ctx: StageContext): Promise<StageResult> {
  if (ctx.skip.has('unit')) return skipped('unit', ctx.skipReason ?? 'opted out');
  const vitest = `${ctx.gameDir}/node_modules/vitest/vitest.mjs`;
  if (!existsSync(vitest)) return skipped('unit', 'vitest is not installed in the game');
  if (!existsSync(`${ctx.gameDir}/vitest.config.ts`)) {
    return skipped('unit', 'the template has no vitest config');
  }
  const result = await run(process.execPath, [vitest, 'run'], {
    cwd: ctx.gameDir,
    env: { CI: '1' },
    timeoutMs: 300_000,
  });
  return {
    name: 'unit',
    status: result.status === 0 ? 'pass' : 'fail',
    durationMs: result.durationMs,
    detail: result.status === 0 ? undefined : detail(result.output),
  };
}

/**
 * `gameable build`, without the componentize step unless asked for it.
 *
 * @param ctx Where the game is.
 * @returns The stage result.
 */
export async function stageBuild(ctx: StageContext): Promise<StageResult> {
  if (ctx.skip.has('build')) return skipped('build', ctx.skipReason ?? 'opted out');
  const cli = `${ctx.repoRoot}/packages/cli/bin/gameable.mjs`;
  if (!existsSync(cli)) return skipped('build', `${cli} is missing; build gameable/cli once`);
  const wasm = process.env['GAMEABLE_LLM_EVAL_WASM'] === '1';
  const result = await run(process.execPath, [cli, 'build', ...(wasm ? [] : ['--no-wasm'])], {
    cwd: ctx.gameDir,
    timeoutMs: wasm ? 900_000 : 300_000,
  });
  return {
    name: 'build',
    status: result.status === 0 ? 'pass' : 'fail',
    durationMs: result.durationMs,
    detail: result.status === 0 ? undefined : detail(result.output),
  };
}

/**
 * Preview the built game and check it boots in headless Chromium.
 *
 * The template publishes `window.__AOS_READY__` and `window.__AOS_ERROR__`
 * under `?test=1` — the same hooks `tests/e2e/fps.spec.ts` drives — so this
 * asks the only question a smoke test should: did the whole host chain come
 * up, or did it throw?
 *
 * @param ctx Where the game is.
 * @param port Which port to preview on.
 * @returns The stage result.
 */
export async function stageE2e(ctx: StageContext, port = 4187): Promise<StageResult> {
  if (ctx.skip.has('e2e')) return skipped('e2e', ctx.skipReason ?? 'opted out');
  if (process.env['GAMEABLE_LLM_EVAL_E2E'] !== '1') {
    return skipped('e2e', 'set GAMEABLE_LLM_EVAL_E2E=1 to run the browser smoke test');
  }
  const script = fileURLToPath(new URL('./e2eSmoke.ts', import.meta.url));
  const started = Date.now();
  const result = await run(process.execPath, [script, ctx.gameDir, ctx.repoRoot, String(port)], {
    cwd: ctx.gameDir,
    timeoutMs: 600_000,
  });
  if (result.status === 2) {
    return {
      name: 'e2e',
      status: 'skipped',
      durationMs: Date.now() - started,
      detail: detail(result.output),
    };
  }
  return {
    name: 'e2e',
    status: result.status === 0 ? 'pass' : 'fail',
    durationMs: Date.now() - started,
    detail: result.status === 0 ? undefined : detail(result.output),
  };
}
