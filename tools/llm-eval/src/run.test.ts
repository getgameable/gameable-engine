/**
 * The runner, in two halves.
 *
 * The first half is always on and needs nothing but the repository: argument
 * parsing, request assembly, the canned `--dry-run` answer, and applying it.
 * It is the part that has to keep working in CI on a machine with no network
 * and no API key.
 *
 * The second half actually scaffolds a game, installs into the shared cache
 * and runs all five stages. That is the real end-to-end proof, and it costs
 * about forty seconds warm and a few minutes on a cold npm cache, so it is
 * behind `GAMEABLE_LLM_EVAL_SLOW=1`.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { parseFences } from './fences.ts';
import { createFakeClient } from './model.ts';
import { loadPrompts, runChecks } from './prompts.ts';
import { buildRequest, bundlePathFor } from './request.ts';
import type { RunReport } from './score.ts';
import { cannedCorrectAnswer, clientFor, main, parseOptions } from './run.ts';
import { findRepoRoot, resolveTemplate } from './workspace.ts';

const repoRoot = findRepoRoot();
const prompts = loadPrompts();
const scratch = mkdtempSync(join(tmpdir(), 'llm-eval-run-'));

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

describe('parseOptions', () => {
  it('defaults to the small hosted model', () => {
    const options = parseOptions([]);
    expect(options.model).toBe('claude-haiku-4-5');
    expect(options.provider).toBe('anthropic');
    expect(options.prompts).toBe('all');
    expect(options.effort).toBe('medium');
  });

  it('infers ollama from a model id that is not a claude', () => {
    expect(parseOptions(['--model', 'qwen2.5-coder:7b']).provider).toBe('ollama');
  });

  it('lets --provider win over the inference', () => {
    expect(parseOptions(['--model', 'qwen2.5-coder:7b', '--provider', 'fake']).provider).toBe(
      'fake',
    );
  });

  it('makes --dry-run mean one prompt with the fake client', () => {
    const options = parseOptions(['--dry-run']);
    expect(options.provider).toBe('fake');
    expect(options.prompts).toBe('double-player-move-speed');
    expect(options.dryRun).toBe(true);
  });

  it('does not override an explicit prompt selection in a dry run', () => {
    expect(parseOptions(['--dry-run', '--prompts', 'add-shotgun']).prompts).toBe('add-shotgun');
  });

  it('rejects nonsense', () => {
    expect(() => parseOptions(['--nope'])).toThrow('unknown option --nope');
    expect(() => parseOptions(['--model'])).toThrow('needs a value');
    expect(() => parseOptions(['--effort', 'colossal'])).toThrow('--effort must be');
    expect(() => parseOptions(['--provider', 'openai'])).toThrow('--provider must be');
  });
});

describe('clientFor', () => {
  it('never constructs a paying client without the live flag', () => {
    const live = process.env['GAMEABLE_LLM_EVAL_LIVE'];
    delete process.env['GAMEABLE_LLM_EVAL_LIVE'];
    try {
      expect(() => clientFor(parseOptions(['--model', 'claude-haiku-4-5']))).toThrow(
        'GAMEABLE_LLM_EVAL_LIVE=1',
      );
    } finally {
      if (live !== undefined) process.env['GAMEABLE_LLM_EVAL_LIVE'] = live;
    }
  });

  it('builds a fake client for a dry run', () => {
    const client = clientFor(parseOptions(['--dry-run']));
    expect(client.provider).toBe('fake');
    expect(client.id).toBe('fake-dry-run');
  });

  it('builds an ollama client without any credential', () => {
    const client = clientFor(parseOptions(['--model', 'llama3.1:8b']));
    expect(client.provider).toBe('ollama');
    expect(client.id).toBe('llama3.1:8b');
  });
});

describe('the dry run pipeline, offline', () => {
  const template = resolveTemplate(repoRoot, 'fps');
  const gameDir = template?.dir ?? `${repoRoot}/fixtures/tiny-game`;
  const prompt = prompts.find((p) => p.id === 'double-player-move-speed');

  it('has a template or a fixture to work against', () => {
    expect(existsSync(`${gameDir}/package.json`)).toBe(true);
    expect(prompt).toBeDefined();
  });

  it('puts the docs bundle and the current source in the system prompt', () => {
    const bundle = readFileSync(bundlePathFor(repoRoot, 'fps'), 'utf8');
    const request = buildRequest({ prompt: prompt!, bundle, gameDir });
    // The bundle comes first, so one cache breakpoint covers it.
    expect(request.system.startsWith(bundle.slice(0, 200))).toBe(true);
    expect(request.system).toContain('# The game you are editing');
    expect(request.includedFiles).toContain('src/game.ts');
    expect(request.system).toContain('## `src/game.ts`');
  });

  it('puts the task, the id and the output contract in the user message, and nothing else', () => {
    const bundle = readFileSync(bundlePathFor(repoRoot, 'fps'), 'utf8');
    const request = buildRequest({ prompt: prompt!, bundle, gameDir });
    expect(request.user).toContain('task-id: double-player-move-speed');
    expect(request.user).toContain(prompt!.prompt.trim());
    expect(request.user).toContain('// file: src/game.ts');
    expect(request.user).not.toContain('# FILE: AGENTS.md');
  });

  it('answers, applies and satisfies the prompt checks — end to end, no network', async () => {
    const bundle = readFileSync(bundlePathFor(repoRoot, 'fps'), 'utf8');
    const request = buildRequest({ prompt: prompt!, bundle, gameDir });
    const client = createFakeClient(cannedCorrectAnswer, 'fake-dry-run');

    const completion = await client.complete({ system: request.system, user: request.user });
    expect(completion.stopReason).toBe('end_turn');
    // The counts are stand-ins, but they have to be shaped like the real ones:
    // the bundle is billed as a cache write, not as fresh input.
    expect(completion.usage.cacheCreationTokens).toBeGreaterThan(10_000);
    expect(completion.usage.inputTokens).toBeLessThan(1000);
    expect(completion.usage.outputTokens).toBeGreaterThan(100);

    const parsed = parseFences(completion.text);
    expect(parsed.files.map((f) => f.path)).toEqual(['src/game.ts']);
    expect(parsed.rejected).toEqual([]);

    const written = new Map(parsed.files.map((f) => [f.path, f.content]));
    const results = runChecks(prompt!.checks, written);
    expect(results.every((c) => c.ok)).toBe(true);
    expect(written.get('src/game.ts')).toContain('walkSpeed: 10');
  });

  it('reads the cache back on the second call, which is what makes a run affordable', async () => {
    const bundle = readFileSync(bundlePathFor(repoRoot, 'fps'), 'utf8');
    const request = buildRequest({ prompt: prompt!, bundle, gameDir });
    const client = createFakeClient(cannedCorrectAnswer);
    const first = await client.complete({ system: request.system, user: request.user });
    const second = await client.complete({ system: request.system, user: request.user });
    expect(first.usage.cacheCreationTokens).toBeGreaterThan(0);
    expect(first.usage.cacheReadTokens).toBe(0);
    expect(second.usage.cacheCreationTokens).toBe(0);
    expect(second.usage.cacheReadTokens).toBeGreaterThan(0);
  });

  it('refuses to answer a prompt whose game.ts it was never shown', () => {
    expect(() => cannedCorrectAnswer({ system: 'nothing useful', user: '' })).toThrow(
      'expected src/game.ts in the system prompt',
    );
  });
});

const slow = process.env['GAMEABLE_LLM_EVAL_SLOW'] === '1';

describe.skipIf(!slow)('--dry-run, scaffolding and scoring for real', () => {
  it('scaffolds, applies the canned answer and passes every stage it runs', async () => {
    const out = join(scratch, 'results');
    const code = await main(['--dry-run', '--out', out, '--cache', join(scratch, 'cache')]);

    const files = (await import('node:fs')).readdirSync(out).filter((n) => n.endsWith('.json'));
    expect(files).toHaveLength(1);
    const report = JSON.parse(readFileSync(join(out, files[0]!), 'utf8')) as RunReport;

    if (report.baseline.typecheck.status === 'fail') {
      // A red packages/ makes a red eval, by design. Do not blame the harness.
      expect(code).toBe(2);
      return;
    }

    expect(code).toBe(0);
    expect(report.results).toHaveLength(1);
    const only = report.results[0]!;
    expect(only.id).toBe('double-player-move-speed');
    expect(only.pass).toBe(true);
    expect(only.stages.typecheck.status).toBe('pass');
    expect(only.stages.unit.status).toBe('pass');
    expect(only.stages.build.status).toBe('pass');
    expect(only.filesWritten).toEqual(['src/game.ts']);
    expect(report.summary.passRate).toBe(1);
    expect(existsSync(join(out, 'latest.md'))).toBe(true);
    expect(readFileSync(join(out, 'latest.md'), 'utf8')).toContain('100%');
  }, 900_000);
});
