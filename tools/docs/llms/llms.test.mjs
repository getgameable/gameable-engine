/**
 * The llms generator's routing and budget rules (the multiplayer docs review).
 */
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  BUDGETS,
  buildAll,
  buildIndex,
  characterFiles,
  corpusFiles,
  HEADROOM_WARNING,
  headroomWarnings,
  OUTPUTS,
} from '../gen-llms.mjs';
import { publishLlms } from '../publish-llms.mjs';

const CHARACTER_PAGES = [
  'docs/concepts/characters.md',
  'packages/character/README.md',
  'docs/recipes/give-an-npc-a-face.md',
  'docs/recipes/load-a-character.md',
  'docs/recipes/load-a-character-from-asset-manager.md',
  'docs/recipes/preview-a-rig-without-decoders.md',
];

describe('headroomWarnings', () => {
  it('warns for a bundle with less than 5% of its budget left, and only then', () => {
    expect(HEADROOM_WARNING).toBe(0.05);
    const warnings = headroomWarnings([
      { name: 'tight.txt', bytes: 96, budget: 100 },
      { name: 'edge.txt', bytes: 95, budget: 100 },
      { name: 'roomy.txt', bytes: 50, budget: 100 },
      { name: 'over.txt', bytes: 101, budget: 100 },
    ]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/^tight\.txt has 4 B left of its 100 B budget/);
  });
});

describe('the character bundle', () => {
  it('takes the character pages and READMEs out of the core corpus', () => {
    const corpus = corpusFiles();
    for (const page of CHARACTER_PAGES) expect(corpus).not.toContain(page);
    expect(characterFiles()).toEqual(expect.arrayContaining(CHARACTER_PAGES));
    expect(characterFiles()[0]).toBe('AGENTS.md');
  });

  it('is generated, budgeted and pointed to from llms-full.txt and the index', () => {
    const built = buildAll();
    expect(OUTPUTS).toContain('llms-character.txt');
    expect(BUDGETS['llms-character.txt']).toBeGreaterThan(0);
    expect(built['llms-character.txt']).toContain('# FILE: docs/concepts/characters.md');
    expect(built['llms-full.txt']).toContain('Characters: see llms-character.txt');
    expect(built['llms-full.txt']).not.toContain('# FILE: docs/concepts/characters.md');
    expect(built['llms.txt']).toContain('- [llms-character.txt](llms-character.txt): ');
  });
});

describe('llms.txt', () => {
  it('no longer calls llms-full.txt the entire corpus', () => {
    expect(buildIndex()).not.toMatch(/entire corpus|whole corpus/);
  });

  it('keeps room for the next bundle line: at least 5% of its budget free', () => {
    const bytes = Buffer.byteLength(buildIndex(), 'utf8');
    expect(BUDGETS['llms.txt'] - bytes).toBeGreaterThanOrEqual(
      BUDGETS['llms.txt'] * HEADROOM_WARNING,
    );
  });
});

describe('publishLlms', () => {
  it('publishes every bundle the generator writes, from the one list', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gameable-publish-'));
    try {
      publishLlms(dir);
      const published = readdirSync(dir);
      for (const name of OUTPUTS) expect(published).toContain(name);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
