import { describe, expect, it } from 'vitest';

import { flagBool, flagNumber, flagString, parseArgs } from './args.js';

const SPEC = {
  boolean: ['release', 'report', 'wasm', 'gate'],
  value: ['port', 'template'],
  alias: { p: 'port', t: 'template', r: 'release' },
};

describe('parseArgs', () => {
  it('treats bare words as positionals', () => {
    expect(parseArgs(['my-game', 'extra'], SPEC).positionals).toEqual(['my-game', 'extra']);
  });

  it('sets a declared boolean', () => {
    expect(parseArgs(['--release'], SPEC).flags).toEqual({ release: true });
  });

  it('clears a declared boolean with --no-', () => {
    expect(parseArgs(['--no-wasm'], SPEC).flags).toEqual({ wasm: false });
  });

  it('reads a value from the next token', () => {
    expect(parseArgs(['--port', '4000'], SPEC).flags).toEqual({ port: '4000' });
  });

  it('reads a value from --key=value', () => {
    expect(parseArgs(['--template=fps'], SPEC).flags).toEqual({ template: 'fps' });
  });

  it('keeps a value that looks like a path', () => {
    const parsed = parseArgs(['--template', 'F:/games/fps'], SPEC);
    expect(parsed.flags.template).toBe('F:/games/fps');
  });

  it('expands single-character aliases', () => {
    expect(parseArgs(['-p', '5173', '-r'], SPEC).flags).toEqual({ port: '5173', release: true });
  });

  it('stops parsing at --', () => {
    const parsed = parseArgs(['build', '--', '--release'], SPEC);
    expect(parsed.positionals).toEqual(['build', '--release']);
    expect(parsed.flags).toEqual({});
  });

  it('collects undeclared options instead of guessing', () => {
    expect(parseArgs(['--relase'], SPEC).unknown).toEqual(['--relase']);
  });

  it('rejects --no- on something that is not a boolean', () => {
    expect(parseArgs(['--no-port'], SPEC).unknown).toEqual(['--no-port']);
  });

  it('complains when a value option has no value', () => {
    expect(parseArgs(['--port'], SPEC).unknown).toEqual(['--port (expected a value)']);
  });

  it('does not swallow the next option as a value', () => {
    const parsed = parseArgs(['--port', '--release'], SPEC);
    expect(parsed.unknown).toEqual(['--port (expected a value)']);
    expect(parsed.flags).toEqual({ release: true });
  });

  it('leaves an unknown alias alone', () => {
    expect(parseArgs(['-z'], SPEC).unknown).toEqual(['-z']);
  });
});

describe('flag readers', () => {
  it('falls back when a flag is absent', () => {
    expect(flagBool({}, 'wasm', true)).toBe(true);
    expect(flagString({}, 'template', 'fps')).toBe('fps');
    expect(flagNumber({}, 'port', 5173)).toBe(5173);
  });

  it('reads present flags', () => {
    expect(flagBool({ wasm: false }, 'wasm', true)).toBe(false);
    expect(flagString({ template: 'third-person' }, 'template', 'fps')).toBe('third-person');
    expect(flagNumber({ port: '4000' }, 'port', 5173)).toBe(4000);
  });

  it('treats --flag=false as false', () => {
    expect(flagBool({ gate: 'false' }, 'gate', true)).toBe(false);
  });

  it('ignores an unparseable number', () => {
    expect(flagNumber({ port: 'abc' }, 'port', 5173)).toBe(5173);
  });
});
