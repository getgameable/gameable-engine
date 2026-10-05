import { describe, expect, it } from 'vitest';

import { loadPrompts, selectPrompts, validatePrompt } from './prompts.ts';

const prompts = loadPrompts();

describe('the task set', () => {
  it('is about twenty prompts', () => {
    expect(prompts.length).toBeGreaterThanOrEqual(18);
    expect(prompts.length).toBeLessThanOrEqual(24);
  });

  it('covers both templates', () => {
    expect(prompts.some((p) => p.template === 'fps')).toBe(true);
    expect(prompts.some((p) => p.template === 'third-person')).toBe(true);
  });

  it('marks every third-person prompt as waiting on its template', () => {
    for (const prompt of prompts.filter((p) => p.template === 'third-person')) {
      expect(prompt.skipUntilTemplate, prompt.id).toBe(true);
    }
  });

  it('has the headline tasks from the plan', () => {
    const ids = prompts.map((p) => p.id);
    expect(ids).toContain('add-shotgun');
    expect(ids).toContain('enemies-flee-at-low-health');
    expect(ids).toContain('hud-score-counter');
    expect(ids).toContain('double-player-move-speed');
    expect(ids).toContain('health-pickup-heals-50');
    expect(ids).toContain('win-on-60-second-timer');
    expect(ids).toContain('fps-from-scratch');
  });

  it('has exactly one from-scratch prompt, and it empties src/', () => {
    const scratch = prompts.filter((p) => p.scaffoldEmpty === true);
    expect(scratch).toHaveLength(1);
    expect(scratch[0]?.id).toBe('fps-from-scratch');
    // The template's own suite imports the template's own modules, so it cannot apply.
    expect(scratch[0]?.skipStages).toContain('unit');
    expect(scratch[0]?.skipReason).toBeTypeOf('string');
  });

  it('gives every prompt at least one assertion and a plausible file to write', () => {
    for (const prompt of prompts) {
      expect(prompt.checks.length, prompt.id).toBeGreaterThan(0);
      expect(prompt.expectedFiles.length, prompt.id).toBeGreaterThan(0);
      for (const file of prompt.expectedFiles) {
        expect(file, prompt.id).toMatch(/^src\//);
      }
    }
  });

  it('writes every check as a valid regular expression', () => {
    for (const prompt of prompts) {
      for (const check of prompt.checks) {
        expect(
          () => new RegExp(check.pattern, check.flags ?? 'i'),
          `${prompt.id}: ${check.pattern}`,
        ).not.toThrow();
      }
    }
  });

  it('gives every prompt a task that reads like a change request', () => {
    for (const prompt of prompts) {
      expect(prompt.prompt.length, prompt.id).toBeGreaterThan(40);
      // The prompt must not leak the assertion: that would test compliance, not competence.
      expect(prompt.prompt, prompt.id).not.toContain('hud.set');
    }
  });
});

describe('validatePrompt', () => {
  const valid = {
    id: 'x',
    title: 'x',
    prompt: 'do a thing',
    template: 'fps',
    expectedFiles: ['src/game.ts'],
    checks: [{ file: '*', pattern: 'thing' }],
  };

  it('accepts a good one', () => {
    expect(validatePrompt(valid, 'x.json').id).toBe('x');
  });

  it.each([
    [{ ...valid, id: '' }, 'non-empty string id'],
    [{ ...valid, template: 'rts' }, 'template must be'],
    [{ ...valid, checks: 'nope' }, 'checks must be an array'],
    [{ ...valid, expectedFiles: 'nope' }, 'expectedFiles must be an array'],
    [{ ...valid, checks: [{ file: '*', pattern: '(' }] }, 'not a valid regular expression'],
    [{ ...valid, checks: [{ pattern: 'x' }] }, 'needs a file and a pattern'],
  ])('rejects a bad one (%#)', (input, message) => {
    expect(() => validatePrompt(input, 'x.json')).toThrow(message);
  });
});

describe('selectPrompts', () => {
  it('takes everything by default', () => {
    expect(selectPrompts(prompts, 'all')).toHaveLength(prompts.length);
    expect(selectPrompts(prompts, '')).toHaveLength(prompts.length);
  });

  it('takes one template', () => {
    const fps = selectPrompts(prompts, 'fps');
    expect(fps.length).toBeGreaterThan(0);
    expect(fps.every((p) => p.template === 'fps')).toBe(true);
  });

  it('takes a comma-separated list of ids', () => {
    expect(selectPrompts(prompts, 'add-shotgun, hud-score-counter').map((p) => p.id)).toEqual([
      'add-shotgun',
      'hud-score-counter',
    ]);
  });

  it('names the id it could not find', () => {
    expect(() => selectPrompts(prompts, 'add-shotgun,nope')).toThrow('nope');
  });
});
