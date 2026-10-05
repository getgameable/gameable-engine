import { describe, expect, it } from 'vitest';

import {
  applyTokens,
  leftoverTokens,
  normaliseManifest,
  toPackageName,
  toTitle,
} from './tokens.js';

describe('applyTokens', () => {
  it('substitutes every occurrence', () => {
    expect(applyTokens('{{name}} and {{name}}', { name: 'my-fps' })).toBe('my-fps and my-fps');
  });

  it('tolerates inner whitespace', () => {
    expect(applyTokens('{{ title }}', { title: 'My FPS' })).toBe('My FPS');
  });

  it('leaves an unknown token visible rather than blanking it', () => {
    expect(applyTokens('{{nope}}', { name: 'x' })).toBe('{{nope}}');
  });

  it('does not touch ordinary braces', () => {
    expect(applyTokens('const a = { b: 1 };', { name: 'x' })).toBe('const a = { b: 1 };');
  });

  it('substitutes inside JSON', () => {
    const out = applyTokens('{"name": "{{name}}", "version": "{{aosVersion}}"}', {
      name: 'my-fps',
      aosVersion: '0.2.0',
    });
    expect(JSON.parse(out)).toEqual({ name: 'my-fps', version: '0.2.0' });
  });
});

describe('leftoverTokens', () => {
  it('finds nothing in fully substituted text', () => {
    expect(leftoverTokens(applyTokens('{{name}}', { name: 'x' }))).toEqual([]);
  });

  it('reports what was missed, deduplicated and sorted', () => {
    expect(leftoverTokens('{{title}} {{name}} {{title}}')).toEqual(['name', 'title']);
  });
});

describe('toPackageName', () => {
  it('lowercases and dashes', () => {
    expect(toPackageName('My FPS!')).toBe('my-fps');
  });

  it('keeps a name that is already fine', () => {
    expect(toPackageName('my-game')).toBe('my-game');
  });

  it('trims leading and trailing punctuation', () => {
    expect(toPackageName('  .my-game.  ')).toBe('my-game');
  });

  it('falls back when nothing usable is left', () => {
    expect(toPackageName('!!!')).toBe('my-game');
  });
});

describe('toTitle', () => {
  it('title-cases a dashed name', () => {
    expect(toTitle('my-first-fps')).toBe('My First Fps');
  });
});

describe('normaliseManifest', () => {
  it('fills in everything a missing template.json leaves out', () => {
    const manifest = normaliseManifest('fps', undefined);
    expect(manifest).toEqual({
      name: 'fps',
      title: 'Fps',
      description: '',
      tokens: {},
      exclude: [],
      rename: {},
    });
  });

  it('keeps what the template declared', () => {
    const manifest = normaliseManifest('fps', {
      title: 'First-person shooter',
      description: 'walk, shoot, win',
      tokens: { title: 'My FPS' },
      exclude: ['notes.md'],
      rename: { _gitignore: '.gitignore' },
    });
    expect(manifest.title).toBe('First-person shooter');
    expect(manifest.tokens).toEqual({ title: 'My FPS' });
    expect(manifest.exclude).toEqual(['notes.md']);
  });

  it('ignores fields of the wrong shape', () => {
    const manifest = normaliseManifest('fps', { tokens: { n: 1 }, exclude: 'nope' });
    expect(manifest.tokens).toEqual({});
    expect(manifest.exclude).toEqual([]);
  });
});
