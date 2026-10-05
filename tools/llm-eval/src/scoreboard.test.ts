import { describe, expect, it } from 'vitest';

import type { Usage } from './model.ts';
import type { PromptResult, RunReport } from './score.ts';
import { CLEAN_BASELINE, summarise } from './score.ts';
import {
  formatDuration,
  formatTokens,
  renderScoreboard,
  THRESHOLDS,
  thresholdFor,
} from './scoreboard.ts';
import type { StageResult } from './stages.ts';

const USAGE: Usage = {
  inputTokens: 1200,
  outputTokens: 800,
  cacheReadTokens: 15_000,
  cacheCreationTokens: 0,
};

/**
 * A stage result.
 *
 * @param name Stage name.
 * @param status Outcome.
 * @param detail Failure text.
 * @returns The result.
 */
function stage(
  name: StageResult['name'],
  status: StageResult['status'],
  detail?: string,
): StageResult {
  return { name, status, durationMs: 10, ...(detail === undefined ? {} : { detail }) };
}

/**
 * A prompt result, mostly green.
 *
 * @param overrides What to change.
 * @returns The result.
 */
function promptResult(overrides: Partial<PromptResult> = {}): PromptResult {
  return {
    id: 'add-shotgun',
    title: 'Add a shotgun that fires 5 pellets',
    model: 'claude-haiku-4-5',
    provider: 'anthropic',
    pass: true,
    stages: {
      typecheck: stage('typecheck', 'pass'),
      unit: stage('unit', 'pass'),
      build: stage('build', 'pass'),
      e2e: stage('e2e', 'skipped', 'set GAMEABLE_LLM_EVAL_E2E=1'),
      checks: stage('checks', 'pass'),
    },
    tokens: USAGE,
    cost: 0.0057,
    durationMs: 12_345,
    transcript: 'results/transcripts/run/add-shotgun',
    stopReason: 'end_turn',
    filesWritten: ['src/systems/weapon.ts'],
    rejectedPaths: [],
    missingExpectedFiles: [],
    checks: [],
    ...overrides,
  };
}

/**
 * A run report around some results.
 *
 * @param results The prompt results.
 * @param overrides What to change on the report.
 * @returns The report.
 */
function report(results: PromptResult[], overrides: Partial<RunReport> = {}): RunReport {
  return {
    version: 1,
    startedAt: '2026-09-13T10:00:00.000Z',
    finishedAt: '2026-09-13T10:20:00.000Z',
    model: 'claude-haiku-4-5',
    provider: 'anthropic',
    template: { name: 'fps', dir: 'F:/work/aos/gameable/templates/fps' },
    templateRepairs: [],
    baseline: CLEAN_BASELINE,
    linkMode: 'junction',
    node: 'v24.14.0',
    options: { prompts: 'all', effort: 'medium', wasm: false, e2e: false, dryRun: false },
    results,
    skipped: [],
    summary: summarise(results),
    ...overrides,
  };
}

describe('thresholdFor', () => {
  it('holds a hosted model to 80% and a local one to 50%', () => {
    expect(thresholdFor('anthropic').value).toBe(THRESHOLDS.hosted);
    expect(thresholdFor('ollama').value).toBe(THRESHOLDS.local);
  });

  it('holds the fake client to nothing, because it proves plumbing not quality', () => {
    expect(thresholdFor('fake').value).toBe(0);
  });
});

describe('renderScoreboard', () => {
  it('leads with the pass rate and whether it clears the bar', () => {
    const markdown = renderScoreboard(
      report([
        promptResult(),
        promptResult({ id: 'b', pass: true }),
        promptResult({ id: 'c', pass: true }),
        promptResult({ id: 'd', pass: true }),
        promptResult({ id: 'e', pass: false, failure: 'typecheck' }),
      ]),
    );
    expect(markdown).toContain('**80%**');
    expect(markdown).toContain('4 of 5 prompts passed');
    expect(markdown).toContain('**meets** the 80% bar for a hosted small model');
  });

  it('says so when the run is below the bar', () => {
    const markdown = renderScoreboard(report([promptResult({ pass: false, failure: 'checks' })]));
    expect(markdown).toContain('**below** the 80% bar');
  });

  it('renders one table row per prompt, with a cell per stage', () => {
    const markdown = renderScoreboard(report([promptResult()]));
    expect(markdown).toContain('| typecheck | unit | build | e2e | checks |');
    expect(markdown).toContain('`add-shotgun`');
    // The skipped e2e cell is a dash, not a pass.
    expect(markdown).toMatch(/\| pass \| pass \| pass \| – \| pass \| pass \|/);
  });

  it('buckets failures and explains each bucket', () => {
    const markdown = renderScoreboard(
      report([
        promptResult({ id: 'a', pass: false, failure: 'typecheck' }),
        promptResult({ id: 'b', pass: false, failure: 'refusal' }),
      ]),
    );
    expect(markdown).toContain('## Failures by cause');
    expect(markdown).toContain('| `typecheck` | 1 | used an API that does not exist');
    expect(markdown).toContain('| `refusal` | 1 | the model declined the task |');
  });

  it('quotes the failing stage output', () => {
    const markdown = renderScoreboard(
      report([
        promptResult({
          pass: false,
          failure: 'typecheck',
          stages: {
            typecheck: stage('typecheck', 'fail', "src/game.ts(1,1): error TS2305: no 'sweep'"),
            unit: stage('unit', 'skipped'),
            build: stage('build', 'skipped'),
            e2e: stage('e2e', 'skipped'),
            checks: stage('checks', 'skipped'),
          },
        }),
      ]),
    );
    expect(markdown).toContain('error TS2305');
  });

  it('lists failed checks by name instead of a wall of output', () => {
    const markdown = renderScoreboard(
      report([
        promptResult({
          pass: false,
          failure: 'checks',
          checks: [
            {
              check: { file: '*', pattern: 'pellet', note: 'the change is about pellets' },
              ok: false,
              matches: 0,
              detail: 'expected >= 1 match(es) of /pellet/ in *, found 0',
            },
          ],
        }),
      ]),
    );
    expect(markdown).toContain('expected >= 1 match(es) of /pellet/');
    expect(markdown).toContain('the change is about pellets');
  });

  it('names the paths it refused to write', () => {
    const markdown = renderScoreboard(
      report([
        promptResult({
          pass: false,
          failure: 'checks',
          rejectedPaths: [{ path: '../../etc/passwd', reason: 'path traversal (..) rejected' }],
        }),
      ]),
    );
    expect(markdown).toContain('refused to write `../../etc/passwd`');
  });

  it('lists prompts that were never attempted', () => {
    const markdown = renderScoreboard(
      report([promptResult()], {
        skipped: [
          {
            id: 'tp-interactable-door',
            title: 'door',
            reason: 'templates/third-person does not exist yet',
          },
        ],
      }),
    );
    expect(markdown).toContain('## Not attempted');
    expect(markdown).toContain('templates/third-person does not exist yet');
  });

  it('declares the template repairs, so a template bug is never read as a model failure', () => {
    const markdown = renderScoreboard(
      report([promptResult()], { templateRepairs: ['@types/node@26.5.1'] }),
    );
    expect(markdown).toContain('the pristine scaffold did not typecheck');
    expect(markdown).toContain('`@types/node@26.5.1`');
  });

  it('invalidates the whole run when the untouched scaffold is red', () => {
    const markdown = renderScoreboard(
      report([promptResult({ pass: false, failure: 'typecheck' })], {
        baseline: {
          ...CLEAN_BASELINE,
          typecheck: { status: 'fail', detail: 'engineAdapter.ts(699,5): error TS2304' },
        },
      }),
    );
    expect(markdown).toContain('**This run is not valid.**');
    expect(markdown).toContain('error TS2304');
  });

  it('disqualifies only the red stage when typecheck is fine', () => {
    const markdown = renderScoreboard(
      report([promptResult()], {
        baseline: { ...CLEAN_BASELINE, unit: { status: 'fail', detail: '6 failed | 18 passed' } },
      }),
    );
    expect(markdown).not.toContain('This run is not valid');
    expect(markdown).toContain('The untouched scaffold already fails `unit`');
    expect(markdown).toContain('6 failed | 18 passed');
  });

  it('says a substituted template is not comparable', () => {
    const markdown = renderScoreboard(
      report([promptResult()], {
        template: { name: 'tiny-game', dir: 'x', substituteFor: 'fps' },
      }),
    );
    expect(markdown).toContain('standing in for');
  });

  it('carries the cost note through', () => {
    const markdown = renderScoreboard(report([promptResult()]), {
      costNote: 'full 20-prompt run: $0.51',
    });
    expect(markdown).toContain('## Cost');
    expect(markdown).toContain('$0.51');
  });

  it('escapes a pipe in a title so the table survives it', () => {
    const markdown = renderScoreboard(report([promptResult({ title: 'a | b' })]));
    expect(markdown).toContain('a \\| b');
  });
});

describe('formatting', () => {
  it.each([
    [0, '0'],
    [999, '999'],
    [1500, '1.5k'],
    [2_500_000, '2.5M'],
  ])('formats %i tokens as %s', (input, expected) => {
    expect(formatTokens(input)).toBe(expected);
  });

  it.each([
    [500, '500ms'],
    [4500, '4.5s'],
    [63_000, '1m 03s'],
  ])('formats %i ms as %s', (input, expected) => {
    expect(formatDuration(input)).toBe(expected);
  });
});
