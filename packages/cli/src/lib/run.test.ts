import { describe, expect, it } from 'vitest';

import { stripAnsi } from './colors.js';
import { filterJcoNoise, run, runNode } from './run.js';

/** A verbatim UNRESOLVED_IMPORT block, ANSI colours and all. */
const NOISE = [
  "packages\\sdk\\src\\wit\\entry.ts (26:21) \u001B[33m[UNRESOLVED_IMPORT] \u001B[0mCould not resolve 'gameable:engine/env@0.2.0'",
  '    \u001B[38;5;246m╭\u001B[0m\u001B[38;5;246m─\u001B[0m\u001B[38;5;246m[\u001B[0m entry.ts:26:22 \u001B[38;5;246m]\u001B[0m',
  '    \u001B[38;5;246m│\u001B[0m',
  " 26 │ import * as env from 'gameable:engine/env@0.2.0';",
  '    │ Module not found, treating it as an external dependency',
  '    │ Help: The "main" field here was ignored.',
  '\u001B[38;5;246m────╯\u001B[0m',
  '',
].join('\n');

describe('filterJcoNoise', () => {
  it('removes the whole UNRESOLVED_IMPORT block', () => {
    expect(filterJcoNoise(NOISE).trim()).toBe('');
  });

  it('keeps the success line around the noise', () => {
    const text = `${NOISE}OK Successfully written F:/game/.gameable/game.wasm\n`;
    const filtered = filterJcoNoise(text);
    expect(filtered).toContain('OK Successfully written');
    expect(filtered).not.toContain('UNRESOLVED_IMPORT');
    expect(filtered).not.toContain('treating it as an external dependency');
  });

  it('removes three consecutive blocks', () => {
    const filtered = filterJcoNoise(`${NOISE}${NOISE}${NOISE}done\n`);
    expect(filtered.trim()).toBe('done');
  });

  it('keeps a real error', () => {
    const text = `${NOISE}Error: something actually broke\n`;
    expect(filterJcoNoise(text)).toContain('Error: something actually broke');
  });

  it('strips ANSI from what it keeps', () => {
    const filtered = filterJcoNoise('\u001B[33mwarning\u001B[0m: careful\n');
    expect(filtered).toBe('warning: careful\n');
  });
});

describe('stripAnsi', () => {
  it('leaves plain text alone', () => {
    expect(stripAnsi('plain')).toBe('plain');
  });

  it('removes SGR sequences', () => {
    expect(stripAnsi('\u001B[1mbold\u001B[22m')).toBe('bold');
  });
});

describe('run', () => {
  it('runs a node script through process.execPath', async () => {
    const result = await runNode('--version', []);
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(`v${process.versions.node}`);
  });

  it('reports a non-zero status', async () => {
    const result = await run(process.execPath, ['-e', 'process.exit(3)']);
    expect(result.status).toBe(3);
  });

  it('captures output', async () => {
    const result = await run(process.execPath, ['-e', 'console.log("hello")']);
    expect(result.stdout.trim()).toBe('hello');
  });

  it('turns a missing executable into status -1, not a throw', async () => {
    const result = await run('definitely-not-a-real-binary-9f3a', []);
    expect(result.status).toBe(-1);
    expect(result.stderr.length).toBeGreaterThan(0);
  });

  it('passes arguments as an array, so spaces survive', async () => {
    const result = await run(process.execPath, [
      '-e',
      'console.log(process.argv[1])',
      'F:/path with spaces/game.ts',
    ]);
    expect(result.stdout.trim()).toBe('F:/path with spaces/game.ts');
  });
});
