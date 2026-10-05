/**
 * What counts as a pass, and what a failure gets blamed on.
 *
 * A prompt passes when **every stage that ran, passed**. A skipped stage is
 * not a pass and not a failure — it is an admission that this machine could
 * not answer that question, and the scoreboard says so rather than quietly
 * inflating the number.
 *
 * Failures are bucketed, because "40% pass" is not actionable and "nine of the
 * eleven failures were `typecheck`, all of them inventing the same API" is.
 * The bucket is the *first* thing that went wrong, in the order the stages
 * run — a build failure downstream of a type error is a type error.
 */
import type { Usage } from './model.ts';
import { estimateCost, NO_USAGE } from './model.ts';
import type { CheckResult, StageName } from './prompts.ts';
import type { StageResult } from './stages.ts';
import { BASELINE_STAGES, type Baseline, type BaselineStage } from './workspace.ts';

/** A baseline where nothing is wrong, for tests and for a run with no workspace. */
export const CLEAN_BASELINE: Baseline = Object.fromEntries(
  BASELINE_STAGES.map((name) => [name, { status: 'pass' as const }]),
) as Baseline;

/**
 * Stages the untouched scaffold already fails, so no prompt should be scored on them.
 *
 * @param baseline What {@link Baseline} the workspace probe found.
 * @returns The failing baseline stages, in run order.
 */
export function redBaselineStages(baseline: Baseline): BaselineStage[] {
  return BASELINE_STAGES.filter((name) => baseline[name].status === 'fail');
}

/**
 * The same list, as the set the stage runners take.
 *
 * @param baseline What {@link Baseline} the workspace probe found.
 * @returns Stage names to skip.
 */
export function disqualifiedStages(baseline: Baseline): Set<StageName> {
  return new Set<StageName>(redBaselineStages(baseline));
}

/**
 * Why a prompt failed.
 *
 * The first six are the ones the plan asks for. `e2e` only appears when the
 * browser stage is enabled, and `error` means the harness itself fell over —
 * a network failure, a wedged process — which is never the model's fault.
 */
export type FailureBucket =
  'typecheck' | 'unit' | 'build' | 'checks' | 'refusal' | 'truncated' | 'e2e' | 'error';

/** The order stages run in, which is also the order failures are attributed. */
export const STAGE_ORDER: readonly StageName[] = ['typecheck', 'unit', 'build', 'e2e', 'checks'];

/** One prompt, scored. */
export interface PromptResult {
  /** The prompt id. */
  readonly id: string;
  /** The prompt title, so the scoreboard needs nothing else. */
  readonly title: string;
  /** Which model answered. */
  readonly model: string;
  /** Which family that model belongs to. */
  readonly provider: string;
  /** Every stage that ran, passed. */
  readonly pass: boolean;
  /** The five stages. */
  readonly stages: Readonly<Record<StageName, StageResult>>;
  /** Set when {@link PromptResult.pass} is false. */
  readonly failure?: FailureBucket;
  /** What the completion cost, in tokens. */
  readonly tokens: Usage;
  /** What the completion cost, in dollars. */
  readonly cost: number;
  /** Wall clock for the whole prompt: scaffold, call, apply and score. */
  readonly durationMs: number;
  /** Path to the transcript directory for this prompt. */
  readonly transcript: string;
  /** Why the model stopped generating. */
  readonly stopReason: string;
  /** Files the model wrote, game-relative. */
  readonly filesWritten: readonly string[];
  /** Paths the model asked for that were refused, with reasons. */
  readonly rejectedPaths: readonly { readonly path: string; readonly reason: string }[];
  /** `expectedFiles` the model did not write. Advisory. */
  readonly missingExpectedFiles: readonly string[];
  /** Every assertion, so triage can read them without rerunning anything. */
  readonly checks: readonly CheckResult[];
}

/** A prompt that was not attempted at all. */
export interface SkippedPrompt {
  /** The prompt id. */
  readonly id: string;
  /** The prompt title. */
  readonly title: string;
  /** Why it was skipped. */
  readonly reason: string;
}

/** The whole run, as written to `results/<timestamp>-<model>.json`. */
export interface RunReport {
  /** Schema version of this file. */
  readonly version: 1;
  /** ISO timestamp the run started. */
  readonly startedAt: string;
  /** ISO timestamp the run finished. */
  readonly finishedAt: string;
  /** Which model was under test. */
  readonly model: string;
  /** `anthropic`, `ollama` or `fake`. */
  readonly provider: string;
  /** The template that was scaffolded, and whether it stood in for another. */
  readonly template: {
    readonly name: string;
    readonly dir: string;
    readonly substituteFor?: string;
  };
  /** Packages the harness had to add for the pristine scaffold to typecheck. */
  readonly templateRepairs: readonly string[];
  /**
   * What the untouched scaffold scores, before any model touches it.
   *
   * A red `typecheck` invalidates the whole run — a game typechecks the
   * engine's own source through its `file:` links, so a red `packages/` is a
   * red eval. A red `unit` or `build` disqualifies only that stage, which is
   * then skipped for every prompt rather than charged to the model.
   */
  readonly baseline: Baseline;
  /** How game directories got their `node_modules`. */
  readonly linkMode: string;
  /** Node version, so a regression can be pinned to a toolchain change. */
  readonly node: string;
  /** Which optional stages were on. */
  readonly options: Readonly<Record<string, string | boolean>>;
  /** One entry per attempted prompt. */
  readonly results: readonly PromptResult[];
  /** Prompts that were not attempted. */
  readonly skipped: readonly SkippedPrompt[];
  /** The headline numbers. */
  readonly summary: Summary;
}

/** The headline numbers. */
export interface Summary {
  /** Prompts attempted. */
  readonly attempted: number;
  /** Prompts that passed every stage that ran. */
  readonly passed: number;
  /** `passed / attempted`, or 0 when nothing was attempted. */
  readonly passRate: number;
  /** Prompts not attempted, e.g. a template that does not exist yet. */
  readonly skipped: number;
  /** How many failures landed in each bucket. */
  readonly buckets: Readonly<Record<string, number>>;
  /** Token totals across the run. */
  readonly tokens: Usage;
  /** Dollars across the run. */
  readonly cost: number;
  /** Wall clock across the run. */
  readonly durationMs: number;
  /** Stages that could not be answered on this machine, by name. */
  readonly stagesSkipped: Readonly<Record<string, number>>;
}

/**
 * Decide whether a prompt passed, and if not, what to blame.
 *
 * @param stages The five stage results.
 * @param stopReason Why the model stopped generating.
 * @param harnessError Set when the harness itself failed.
 * @returns Pass and, when false, the bucket.
 */
export function judge(
  stages: Readonly<Record<StageName, StageResult>>,
  stopReason: string,
  harnessError?: string,
): { pass: boolean; failure?: FailureBucket } {
  if (harnessError !== undefined) return { pass: false, failure: 'error' };
  // A refusal or a truncation explains every downstream failure, so it wins.
  if (stopReason === 'refusal') return { pass: false, failure: 'refusal' };
  if (stopReason === 'max_tokens') return { pass: false, failure: 'truncated' };
  for (const name of STAGE_ORDER) {
    const stage = stages[name];
    if (stage.status === 'fail') return { pass: false, failure: name as FailureBucket };
  }
  return { pass: true };
}

/**
 * Add two usage records.
 *
 * @param a One.
 * @param b The other.
 * @returns The sum.
 */
export function addUsage(a: Usage, b: Usage): Usage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheCreationTokens: a.cacheCreationTokens + b.cacheCreationTokens,
  };
}

/**
 * Roll a run's prompt results into the headline numbers.
 *
 * @param results Every attempted prompt.
 * @param skipped Every prompt that was not attempted.
 * @returns The summary written into the result file and the scoreboard.
 */
export function summarise(
  results: readonly PromptResult[],
  skipped: readonly SkippedPrompt[] = [],
): Summary {
  const buckets: Record<string, number> = {};
  const stagesSkipped: Record<string, number> = {};
  let tokens = NO_USAGE;
  let cost = 0;
  let durationMs = 0;
  let passed = 0;

  for (const result of results) {
    if (result.pass) passed += 1;
    else if (result.failure !== undefined) {
      buckets[result.failure] = (buckets[result.failure] ?? 0) + 1;
    }
    tokens = addUsage(tokens, result.tokens);
    cost += result.cost;
    durationMs += result.durationMs;
    for (const name of STAGE_ORDER) {
      if (result.stages[name].status === 'skipped') {
        stagesSkipped[name] = (stagesSkipped[name] ?? 0) + 1;
      }
    }
  }

  return {
    attempted: results.length,
    passed,
    passRate: results.length === 0 ? 0 : passed / results.length,
    skipped: skipped.length,
    buckets,
    tokens,
    cost,
    durationMs,
    stagesSkipped,
  };
}

/**
 * Extrapolate what a full run of `n` prompts would cost from the prompts that
 * actually ran.
 *
 * The cache does most of the work after the first call, so a one-prompt
 * measurement over-states the per-prompt input cost badly. This splits the
 * first call out and scales the rest.
 *
 * @param results What was measured.
 * @param model The model to price it at.
 * @param promptCount How many prompts a full run has.
 * @returns Dollars, and the per-prompt usage it assumed.
 */
export function extrapolateCost(
  results: readonly PromptResult[],
  model: string,
  promptCount: number,
): { total: number; firstCall: number; perCachedCall: number; assumed: Usage } {
  if (results.length === 0) {
    return { total: 0, firstCall: 0, perCachedCall: 0, assumed: NO_USAGE };
  }
  const first = results[0] as PromptResult;
  const firstCall = estimateCost(model, first.tokens);

  // Every call after the first reads the bundle from the cache instead of
  // writing it, which is the whole point of putting it in `system`.
  const cached: Usage = {
    inputTokens: first.tokens.inputTokens,
    outputTokens: first.tokens.outputTokens,
    cacheReadTokens: first.tokens.cacheReadTokens + first.tokens.cacheCreationTokens,
    cacheCreationTokens: 0,
  };
  const perCachedCall = estimateCost(model, cached);

  return {
    total: firstCall + perCachedCall * Math.max(0, promptCount - 1),
    firstCall,
    perCachedCall,
    assumed: cached,
  };
}
