import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import type { PromptResult, RunReport } from './score.ts';
import { CLEAN_BASELINE, summarise } from './score.ts';
import type { StageResult } from './stages.ts';
import {
  citedDoc,
  missingSymbolsFromTsc,
  renderTriage,
  sdkExports,
  sdkImports,
  splitBundle,
  triage,
} from './triage.ts';
import { findRepoRoot } from './workspace.ts';

const repoRoot = findRepoRoot();
const scratch = mkdtempSync(join(tmpdir(), 'llm-eval-triage-'));

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

describe('sdkExports', () => {
  it('reads the real SDK entry point', () => {
    const exports = sdkExports(repoRoot);
    // Values, types and re-exported ECS names all have to be in there.
    expect(exports.has('defineGame')).toBe(true);
    expect(exports.has('prefab')).toBe(true);
    expect(exports.has('Health')).toBe(true);
    expect(exports.has('GameContext')).toBe(true);
    expect(exports.has('PACKAGE')).toBe(true);
  });

  it('does not invent names', () => {
    const exports = sdkExports(repoRoot);
    expect(exports.has('sweepCapsule')).toBe(false);
    expect(exports.has('useFrame')).toBe(false);
  });
});

describe('sdkImports', () => {
  it('reads names out of a value import', () => {
    expect(sdkImports("import { defineGame, Health } from 'gameable';")).toEqual([
      'defineGame',
      'Health',
    ]);
  });

  it('reads names out of a type import and drops inline type modifiers', () => {
    expect(sdkImports("import { type GameContext, prefab } from 'gameable';")).toEqual([
      'GameContext',
      'prefab',
    ]);
    expect(sdkImports("import type { System } from 'gameable';")).toEqual(['System']);
  });

  it('takes the original name from an alias', () => {
    expect(sdkImports("import { hud as gui } from 'gameable';")).toEqual(['hud']);
  });

  it('ignores imports from anywhere else', () => {
    expect(sdkImports("import { Vector3 } from 'three/webgpu';")).toEqual([]);
  });
});

describe('missingSymbolsFromTsc', () => {
  it('picks the symbol out of every shape tsc uses', () => {
    const output = [
      "src/game.ts(3,10): error TS2305: Module '\"gameable\"' has no exported member 'sweep'.",
      "src/systems/weapon.ts(9,20): error TS2339: Property 'raycastAll' does not exist on type 'PhysicsFacade'.",
      "src/hud.ts(4,1): error TS2304: Cannot find name 'setInterval'.",
    ].join('\n');
    expect(missingSymbolsFromTsc(output).sort()).toEqual(['raycastAll', 'setInterval', 'sweep']);
  });

  it('finds nothing in a clean run', () => {
    expect(missingSymbolsFromTsc('')).toEqual([]);
  });
});

describe('splitBundle and citedDoc', () => {
  const bundle = [
    '# a bundle',
    '',
    '# FILE: AGENTS.md',
    'rules about three and wasm',
    '',
    '# FILE: docs/recipes/add-a-weapon.md',
    'shotgun pellets spread raycast damage magazine reload',
    '',
    '# FILE: docs/recipes/add-a-hud-element.md',
    'score counter ammo enemies crosshair message',
  ].join('\n');

  it('splits on the generator markers', () => {
    const sections = splitBundle(bundle);
    expect(sections.map((s) => s.file)).toEqual([
      'AGENTS.md',
      'docs/recipes/add-a-weapon.md',
      'docs/recipes/add-a-hud-element.md',
    ]);
  });

  it('names the recipe closest to a failing task', () => {
    const sections = splitBundle(bundle);
    expect(citedDoc(sections, 'shotgun pellets spread')).toBe('docs/recipes/add-a-weapon.md');
    expect(citedDoc(sections, 'score counter crosshair')).toBe('docs/recipes/add-a-hud-element.md');
  });

  it('says nothing rather than guessing from one weak word', () => {
    expect(citedDoc(splitBundle(bundle), 'something entirely unrelated')).toBeUndefined();
  });
});

describe('triage', () => {
  /**
   * A failing prompt result whose transcript is on disk.
   *
   * @param id Prompt id.
   * @param source The file the model wrote.
   * @param tscDetail The typecheck failure.
   * @returns The result.
   */
  function failing(id: string, source: string, tscDetail: string): PromptResult {
    const dir = join(scratch, 'results', 'transcripts', 'run', id);
    writeFileSync(join(mkdirp(dir), 'src__game.ts'), source, 'utf8');
    const fail: StageResult = {
      name: 'typecheck',
      status: 'fail',
      durationMs: 1,
      detail: tscDetail,
    };
    const skip = (name: StageResult['name']): StageResult => ({
      name,
      status: 'skipped',
      durationMs: 0,
    });
    return {
      id,
      title: id,
      model: 'claude-haiku-4-5',
      provider: 'anthropic',
      pass: false,
      failure: 'typecheck',
      stages: {
        typecheck: fail,
        unit: skip('unit'),
        build: skip('build'),
        e2e: skip('e2e'),
        checks: skip('checks'),
      },
      tokens: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0 },
      cost: 0,
      durationMs: 1,
      transcript: `results/transcripts/run/${id}`,
      stopReason: 'end_turn',
      filesWritten: ['src/game.ts'],
      rejectedPaths: [],
      missingExpectedFiles: [],
      checks: [],
    };
  }

  /**
   * `mkdir -p`, returning the path.
   *
   * @param dir The directory.
   * @returns The same directory.
   */
  function mkdirp(dir: string): string {
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  /**
   * A report around some results.
   *
   * @param results The prompt results.
   * @returns The report.
   */
  function reportOf(results: PromptResult[]): RunReport {
    return {
      version: 1,
      startedAt: '2026-09-13T10:00:00.000Z',
      finishedAt: '2026-09-13T10:20:00.000Z',
      model: 'claude-haiku-4-5',
      provider: 'anthropic',
      template: { name: 'fps', dir: `${repoRoot}/templates/fps` },
      templateRepairs: [],
      baseline: CLEAN_BASELINE,
      linkMode: 'junction',
      node: process.version,
      options: {},
      results,
      skipped: [],
      summary: summarise(results),
    };
  }

  it('calls a symbol two prompts both invented an API simplification candidate', () => {
    const source = "import { defineGame, sweepCapsule } from 'gameable';";
    const tsc = "error TS2305: Module '\"gameable\"' has no exported member 'sweepCapsule'.";
    const report = reportOf([failing('a', source, tsc), failing('b', source, tsc)]);

    const suggestions = triage(report, repoRoot, scratch);
    const found = suggestions.find((s) => s.subject === 'sweepCapsule');
    expect(found?.kind).toBe('API simplification');
    expect(found?.prompts).toEqual(['a', 'b']);
    expect(found?.where).toBe('packages/sdk/src/index.ts');
  });

  it('calls a symbol one prompt invented a doc fix', () => {
    const report = reportOf([
      failing(
        'c',
        "import { defineGame, onCollision } from 'gameable';",
        "error TS2305: Module '\"gameable\"' has no exported member 'onCollision'.",
      ),
    ]);
    const found = triage(report, repoRoot, scratch).find((s) => s.subject === 'onCollision');
    expect(found?.kind).toBe('doc fix');
    expect(found?.where).toBe('docs/recipes/');
  });

  it('does not accuse the model of inventing something the SDK really exports', () => {
    const report = reportOf([
      failing('d', "import { defineGame, prefab, Health } from 'gameable';", ''),
    ]);
    const subjects = triage(report, repoRoot, scratch).map((s) => s.subject);
    expect(subjects).not.toContain('defineGame');
    expect(subjects).not.toContain('prefab');
  });

  it('says nothing at all about a run with no failures', () => {
    const report = reportOf([]);
    expect(triage(report, repoRoot, scratch)).toEqual([]);
  });
});

describe('renderTriage', () => {
  it('groups by kind and says when a group is empty', () => {
    const report: RunReport = {
      version: 1,
      startedAt: 'x',
      finishedAt: 'y',
      model: 'claude-haiku-4-5',
      provider: 'anthropic',
      template: { name: 'fps', dir: 'x' },
      templateRepairs: [],
      baseline: CLEAN_BASELINE,
      linkMode: 'junction',
      node: 'v24',
      options: {},
      results: [],
      skipped: [],
      summary: summarise([]),
    };
    const text = renderTriage(report, [
      {
        kind: 'doc fix',
        subject: 'hud.set',
        prompts: ['hud-score-counter'],
        action: 'show it in a recipe',
        where: 'docs/recipes/add-a-hud-element.md',
      },
    ]);
    expect(text).toContain('API SIMPLIFICATION candidates (0)');
    expect(text).toContain('  none');
    expect(text).toContain('DOC FIX candidates (1)');
    expect(text).toContain('hud.set  [hud-score-counter]');
  });
});
