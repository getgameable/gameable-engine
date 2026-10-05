/**
 * The scoreboard: one markdown page that answers "did it get better?".
 *
 * Written to `results/latest.md` after every run, next to the machine-readable
 * `results/<timestamp>-<model>.json`. It is written for a human skimming a CI
 * comment, so the headline is first and the evidence is underneath.
 */
import { redBaselineStages, STAGE_ORDER, type RunReport } from './score.ts';
import type { StageName } from './prompts.ts';

/** The milestone M6 acceptance bars, from the plan. */
export const THRESHOLDS = {
  /** A hosted small model must clear this. */
  hosted: 0.8,
  /** A local 7–8B model must clear this. */
  local: 0.5,
} as const;

/**
 * Which bar applies to a run.
 *
 * @param provider The client family.
 * @returns The threshold and a label for it.
 */
export function thresholdFor(provider: string): { value: number; label: string } {
  if (provider === 'ollama') return { value: THRESHOLDS.local, label: 'local 7–8B' };
  if (provider === 'fake') return { value: 0, label: 'plumbing only' };
  return { value: THRESHOLDS.hosted, label: 'hosted small model' };
}

/** Glyphs for a stage cell. */
const GLYPH: Readonly<Record<string, string>> = {
  pass: 'pass',
  fail: '**FAIL**',
  skipped: '–',
};

/**
 * Render the whole scoreboard.
 *
 * @param report The run.
 * @param extras Anything the runner knows that the report does not, such as the
 *   extrapolated cost of a full run.
 * @returns Markdown.
 */
export function renderScoreboard(
  report: RunReport,
  extras: { readonly costNote?: string } = {},
): string {
  const s = report.summary;
  const bar = thresholdFor(report.provider);
  const rate = `${(s.passRate * 100).toFixed(0)}%`;
  const verdict =
    bar.value === 0
      ? 'no threshold (fake client)'
      : s.passRate >= bar.value
        ? `**meets** the ${(bar.value * 100).toFixed(0)}% bar for a ${bar.label}`
        : `**below** the ${(bar.value * 100).toFixed(0)}% bar for a ${bar.label}`;

  const lines: string[] = [];
  lines.push('# Gameable Engine LLM evaluation scoreboard');
  lines.push('');
  const red = redBaselineStages(report.baseline);
  if (red.length > 0) {
    const invalid = report.baseline.typecheck.status === 'fail';
    lines.push('> [!WARNING]');
    if (invalid) {
      lines.push(
        '> **This run is not valid.** The untouched scaffold does not typecheck, so nothing',
        '> downstream of it means anything. A generated game links the engine packages with',
        "> `file:`, which means it typechecks the engine's live source: fix",
        '> `npm run typecheck` at the repository root and run the eval again.',
      );
    } else {
      lines.push(
        `> **The untouched scaffold already fails \`${red.join('`, `')}\`.** Those stages`,
        '> measure the repository, not the model, so they were skipped for every prompt and',
        '> the pass rate below is computed without them. Fix them and run the eval again',
        '> for a complete score.',
      );
    }
    for (const name of red) {
      const detail = report.baseline[name].detail;
      if (detail === undefined) continue;
      lines.push('>');
      lines.push(`> \`${name}\`:`);
      lines.push('>');
      lines.push('> ```text');
      for (const line of firstLines(detail, 6).split('\n')) lines.push(`> ${line}`);
      lines.push('> ```');
    }
    lines.push('');
  }
  lines.push(
    `**${rate}** — ${String(s.passed)} of ${String(s.attempted)} prompts passed every stage that ran. ${verdict}.`,
  );
  lines.push('');
  lines.push(`- model: \`${report.model}\` (${report.provider})`);
  lines.push(
    `- template: \`${report.template.name}\`${report.template.substituteFor === undefined ? '' : ` (standing in for \`${report.template.substituteFor}\`)`}`,
  );
  lines.push(`- finished: ${report.finishedAt}`);
  lines.push(`- node: ${report.node}`);
  lines.push(
    `- cost: $${report.summary.cost.toFixed(4)} over ${formatDuration(s.durationMs)} (${formatTokens(s.tokens.inputTokens)} in, ${formatTokens(s.tokens.cacheCreationTokens)} cache write, ${formatTokens(s.tokens.cacheReadTokens)} cache read, ${formatTokens(s.tokens.outputTokens)} out)`,
  );
  if (report.templateRepairs.length > 0) {
    lines.push(
      `- **the pristine scaffold did not typecheck**; the harness added ${report.templateRepairs.map((r) => `\`${r}\``).join(', ')} so the stage measures the model and not the template`,
    );
  }
  lines.push('');

  lines.push('## Per prompt');
  lines.push('');
  lines.push(`| Prompt | ${STAGE_ORDER.join(' | ')} | Result | Tokens (in/out) | Cost | Time |`);
  lines.push(`| --- | ${STAGE_ORDER.map(() => '---').join(' | ')} | --- | --- | --- | --- |`);
  for (const r of report.results) {
    const cells = STAGE_ORDER.map((name) => GLYPH[r.stages[name].status] ?? '?');
    const outcome = r.pass ? 'pass' : `fail (${r.failure ?? 'unknown'})`;
    lines.push(
      `| \`${r.id}\`<br>${escapePipes(r.title)} | ${cells.join(' | ')} | ${outcome} | ${formatTokens(r.tokens.inputTokens + r.tokens.cacheReadTokens)} / ${formatTokens(r.tokens.outputTokens)} | $${r.cost.toFixed(4)} | ${formatDuration(r.durationMs)} |`,
    );
  }
  lines.push('');

  const buckets = Object.entries(s.buckets).sort((a, b) => b[1] - a[1]);
  lines.push('## Failures by cause');
  lines.push('');
  if (buckets.length === 0) {
    lines.push('None.');
  } else {
    lines.push('| Cause | Count | What it means |');
    lines.push('| --- | --- | --- |');
    for (const [bucket, count] of buckets) {
      lines.push(`| \`${bucket}\` | ${String(count)} | ${BUCKET_MEANING[bucket] ?? ''} |`);
    }
  }
  lines.push('');

  const firstFailures = report.results.filter((r) => !r.pass);
  if (firstFailures.length > 0) {
    lines.push('## What went wrong');
    lines.push('');
    for (const r of firstFailures) {
      lines.push(`### \`${r.id}\` — ${r.failure ?? 'unknown'}`);
      lines.push('');
      const stage = STAGE_ORDER.map((n) => r.stages[n]).find((st) => st.status === 'fail');
      const failedChecks = r.checks.filter((c) => !c.ok);
      if (r.failure === 'checks' && failedChecks.length > 0) {
        for (const c of failedChecks) {
          lines.push(
            `- ${c.detail ?? `/${c.check.pattern}/ in ${c.check.file}`}${c.check.note === undefined ? '' : ` — ${c.check.note}`}`,
          );
        }
      } else if (stage?.detail !== undefined) {
        lines.push('```text');
        lines.push(firstLines(stage.detail, 12));
        lines.push('```');
      } else if (r.failure === 'refusal') {
        lines.push('The model declined the task.');
      } else if (r.failure === 'truncated') {
        lines.push('The model ran out of output tokens mid-file.');
      }
      if (r.rejectedPaths.length > 0) {
        lines.push('');
        for (const rejected of r.rejectedPaths) {
          lines.push(`- refused to write \`${rejected.path}\`: ${rejected.reason}`);
        }
      }
      lines.push('');
    }
  }

  if (report.skipped.length > 0) {
    lines.push('## Not attempted');
    lines.push('');
    lines.push('| Prompt | Why |');
    lines.push('| --- | --- |');
    for (const skip of report.skipped) {
      lines.push(`| \`${skip.id}\` | ${escapePipes(skip.reason)} |`);
    }
    lines.push('');
  }

  const stageSkips = Object.entries(s.stagesSkipped);
  if (stageSkips.length > 0) {
    lines.push('## Stages this machine could not answer');
    lines.push('');
    for (const [name, count] of stageSkips) {
      lines.push(
        `- \`${name}\`: skipped on ${String(count)} prompt(s) — ${skipHint(name as StageName)}`,
      );
    }
    lines.push('');
  }

  if (extras.costNote !== undefined) {
    lines.push('## Cost');
    lines.push('');
    lines.push(extras.costNote);
    lines.push('');
  }

  lines.push('---');
  lines.push('');
  lines.push(
    'Generated by `node tools/llm-eval/src/run.ts`. See `docs/concepts/llm-eval.md` for what is being measured.',
  );
  lines.push('');
  return lines.join('\n');
}

/** One sentence per failure bucket, so the table needs no legend elsewhere. */
const BUCKET_MEANING: Readonly<Record<string, string>> = {
  typecheck: 'used an API that does not exist, or got the types wrong',
  unit: "compiled, but broke the game's own rules",
  build: 'typechecked, but did not produce a playable bundle',
  e2e: 'built, but did not boot in a browser',
  checks: 'built and ran, but did not do what was asked',
  refusal: 'the model declined the task',
  truncated: 'the model hit its output ceiling mid-answer',
  error: 'the harness itself failed — not the model',
};

/**
 * What to do about a skipped stage.
 *
 * @param name The stage.
 * @returns A one-line hint.
 */
function skipHint(name: StageName): string {
  if (name === 'e2e') return 'set `GAMEABLE_LLM_EVAL_E2E=1` and `npx playwright install chromium`';
  if (name === 'unit') return 'the template ships no vitest config, or the prompt opted out';
  return 'the prompt opted out, or the tool was not installed';
}

/**
 * Keep the first `n` lines of a blob.
 *
 * @param text The blob.
 * @param n How many lines.
 * @returns The head, with an ellipsis when it was cut.
 */
function firstLines(text: string, n: number): string {
  const lines = text.split('\n');
  return lines.length <= n ? text : `${lines.slice(0, n).join('\n')}\n…`;
}

/**
 * Make a string safe inside a markdown table cell.
 *
 * @param text Any text.
 * @returns The same text with pipes escaped and newlines flattened.
 */
function escapePipes(text: string): string {
  return text.replaceAll('|', '\\|').replaceAll('\n', ' ');
}

/**
 * Human token counts.
 *
 * @param n A token count.
 * @returns `1.2k`, `340`, and so on.
 */
export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

/**
 * Human durations.
 *
 * @param ms Milliseconds.
 * @returns `1.4s`, `2m 03s`.
 */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${String(Math.round(ms))}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${String(minutes)}m ${String(seconds).padStart(2, '0')}s`;
}
