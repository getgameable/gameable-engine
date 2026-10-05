import { describe, expect, it } from 'vitest';

import { estimateCost, type Usage } from './model.ts';
import { runChecks, type Check } from './prompts.ts';
import {
  addUsage,
  CLEAN_BASELINE,
  disqualifiedStages,
  extrapolateCost,
  judge,
  redBaselineStages,
  summarise,
  type PromptResult,
} from './score.ts';
import type { StageResult } from './stages.ts';

/**
 * A stage result.
 *
 * @param name Stage name.
 * @param status Outcome.
 * @returns The result.
 */
function stage(name: StageResult['name'], status: StageResult['status']): StageResult {
  return { name, status, durationMs: 1 };
}

/**
 * All five stages with the same outcome, then overrides.
 *
 * @param status What every stage did.
 * @param overrides Per-stage overrides.
 * @returns The stage record.
 */
function stages(
  status: StageResult['status'],
  overrides: Partial<Record<StageResult['name'], StageResult['status']>> = {},
): Record<StageResult['name'], StageResult> {
  return {
    typecheck: stage('typecheck', overrides.typecheck ?? status),
    unit: stage('unit', overrides.unit ?? status),
    build: stage('build', overrides.build ?? status),
    e2e: stage('e2e', overrides.e2e ?? status),
    checks: stage('checks', overrides.checks ?? status),
  };
}

const USAGE: Usage = {
  inputTokens: 100,
  outputTokens: 200,
  cacheReadTokens: 300,
  cacheCreationTokens: 400,
};

/**
 * A prompt result.
 *
 * @param id Prompt id.
 * @param verdict Pass and failure bucket.
 * @param stageRecord The five stages.
 * @returns The result.
 */
function result(
  id: string,
  verdict: { pass: boolean; failure?: PromptResult['failure'] },
  stageRecord = stages(verdict.pass ? 'pass' : 'fail'),
): PromptResult {
  return {
    id,
    title: id,
    model: 'claude-haiku-4-5',
    provider: 'anthropic',
    pass: verdict.pass,
    stages: stageRecord,
    ...(verdict.failure === undefined ? {} : { failure: verdict.failure }),
    tokens: USAGE,
    cost: estimateCost('claude-haiku-4-5', USAGE),
    durationMs: 1000,
    transcript: `results/transcripts/x/${id}`,
    stopReason: 'end_turn',
    filesWritten: ['src/game.ts'],
    rejectedPaths: [],
    missingExpectedFiles: [],
    checks: [],
  };
}

describe('judge', () => {
  it('passes when every stage that ran, passed', () => {
    expect(judge(stages('pass'), 'end_turn')).toEqual({ pass: true });
  });

  it('treats a skipped stage as neither a pass nor a failure', () => {
    expect(judge(stages('pass', { e2e: 'skipped', unit: 'skipped' }), 'end_turn')).toEqual({
      pass: true,
    });
  });

  it('blames the earliest failing stage', () => {
    expect(judge(stages('fail'), 'end_turn')).toEqual({ pass: false, failure: 'typecheck' });
    expect(judge(stages('pass', { build: 'fail', checks: 'fail' }), 'end_turn')).toEqual({
      pass: false,
      failure: 'build',
    });
  });

  it('prefers a refusal over anything downstream of it', () => {
    expect(judge(stages('fail'), 'refusal')).toEqual({ pass: false, failure: 'refusal' });
  });

  it('prefers a truncation over anything downstream of it', () => {
    expect(judge(stages('fail'), 'max_tokens')).toEqual({ pass: false, failure: 'truncated' });
  });

  it('blames the harness when the harness failed', () => {
    expect(judge(stages('pass'), 'end_turn', 'ECONNRESET')).toEqual({
      pass: false,
      failure: 'error',
    });
  });
});

describe('summarise', () => {
  it('counts passes, buckets failures and totals the cost', () => {
    const summary = summarise(
      [
        result('a', { pass: true }),
        result('b', { pass: false, failure: 'typecheck' }),
        result('c', { pass: false, failure: 'typecheck' }),
        result('d', { pass: false, failure: 'checks' }),
      ],
      [{ id: 'e', title: 'e', reason: 'no template' }],
    );
    expect(summary.attempted).toBe(4);
    expect(summary.passed).toBe(1);
    expect(summary.passRate).toBeCloseTo(0.25);
    expect(summary.skipped).toBe(1);
    expect(summary.buckets).toEqual({ typecheck: 2, checks: 1 });
    expect(summary.tokens.outputTokens).toBe(800);
    expect(summary.durationMs).toBe(4000);
    expect(summary.cost).toBeCloseTo(estimateCost('claude-haiku-4-5', USAGE) * 4, 10);
  });

  it('counts stages this machine could not answer', () => {
    const summary = summarise([
      result('a', { pass: true }, stages('pass', { e2e: 'skipped' })),
      result('b', { pass: true }, stages('pass', { e2e: 'skipped', unit: 'skipped' })),
    ]);
    expect(summary.stagesSkipped).toEqual({ e2e: 2, unit: 1 });
  });

  it('reports zero rather than dividing by nothing', () => {
    expect(summarise([]).passRate).toBe(0);
  });
});

describe('estimateCost', () => {
  it('prices cache reads at a tenth and cache writes at one and a quarter', () => {
    // 1000 fresh input, 1000 cached read, 1000 cache write, 1000 output, Haiku $1/$5.
    const cost = estimateCost('claude-haiku-4-5', {
      inputTokens: 1000,
      cacheReadTokens: 1000,
      cacheCreationTokens: 1000,
      outputTokens: 1000,
    });
    const expected = (1000 + 100 + 1250) * 1e-6 + 1000 * 5e-6;
    expect(cost).toBeCloseTo(expected, 12);
  });

  it('costs nothing for a model with no published price', () => {
    expect(estimateCost('qwen2.5-coder:7b', USAGE)).toBe(0);
  });
});

describe('extrapolateCost', () => {
  it('charges the bundle once and reads it back for the rest', () => {
    const measured = result('a', { pass: true });
    const forecast = extrapolateCost([measured], 'claude-haiku-4-5', 20);
    expect(forecast.perCachedCall).toBeLessThan(forecast.firstCall);
    expect(forecast.total).toBeCloseTo(forecast.firstCall + forecast.perCachedCall * 19, 10);
    // The cache write becomes a cache read.
    expect(forecast.assumed.cacheCreationTokens).toBe(0);
    expect(forecast.assumed.cacheReadTokens).toBe(700);
  });

  it('forecasts nothing from nothing', () => {
    expect(extrapolateCost([], 'claude-haiku-4-5', 20).total).toBe(0);
  });
});

describe('the baseline', () => {
  it('disqualifies nothing when the untouched scaffold is green', () => {
    expect(redBaselineStages(CLEAN_BASELINE)).toEqual([]);
    expect(disqualifiedStages(CLEAN_BASELINE).size).toBe(0);
  });

  it('disqualifies exactly the stages that already fail, in run order', () => {
    const baseline = {
      ...CLEAN_BASELINE,
      unit: { status: 'fail' as const, detail: '6 failed' },
      build: { status: 'fail' as const },
    };
    expect(redBaselineStages(baseline)).toEqual(['unit', 'build']);
    expect([...disqualifiedStages(baseline)]).toEqual(['unit', 'build']);
  });

  it('carries the detail so the scoreboard can quote it', () => {
    const baseline = {
      ...CLEAN_BASELINE,
      typecheck: { status: 'fail' as const, detail: 'TS2304' },
    };
    expect(baseline.typecheck.detail).toBe('TS2304');
  });
});

describe('addUsage', () => {
  it('adds every field', () => {
    expect(addUsage(USAGE, USAGE)).toEqual({
      inputTokens: 200,
      outputTokens: 400,
      cacheReadTokens: 600,
      cacheCreationTokens: 800,
    });
  });
});

describe('runChecks', () => {
  const written = new Map([
    ['src/hud.ts', 'ctx.hud.set({ text: { score: String(score) } });'],
    ['src/game.ts', 'walkSpeed: 10,'],
  ]);

  it('passes a present pattern', () => {
    const checks: Check[] = [{ file: 'src/hud.ts', pattern: 'score' }];
    expect(runChecks(checks, written)[0]?.ok).toBe(true);
  });

  it('searches every written file when the file is *', () => {
    expect(runChecks([{ file: '*', pattern: 'walkSpeed' }], written)[0]?.ok).toBe(true);
  });

  it('fails when the file was never written', () => {
    const [only] = runChecks([{ file: 'src/missing.ts', pattern: 'x' }], written);
    expect(only?.ok).toBe(false);
    expect(only?.detail).toContain('was not written');
  });

  it('honours minCount', () => {
    expect(runChecks([{ file: 'src/hud.ts', pattern: 'score', minCount: 2 }], written)[0]?.ok).toBe(
      true,
    );
    expect(runChecks([{ file: 'src/hud.ts', pattern: 'score', minCount: 9 }], written)[0]?.ok).toBe(
      false,
    );
  });

  it('honours absent mode', () => {
    expect(
      runChecks([{ file: '*', pattern: "from 'three'", mode: 'absent' }], written)[0]?.ok,
    ).toBe(true);
    expect(runChecks([{ file: '*', pattern: 'walkSpeed', mode: 'absent' }], written)[0]?.ok).toBe(
      false,
    );
  });

  it('is case insensitive by default and respects explicit flags', () => {
    expect(runChecks([{ file: 'src/game.ts', pattern: 'WALKSPEED' }], written)[0]?.ok).toBe(true);
    expect(
      runChecks([{ file: 'src/game.ts', pattern: 'WALKSPEED', flags: '' }], written)[0]?.ok,
    ).toBe(false);
  });
});
