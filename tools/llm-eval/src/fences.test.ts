import { describe, expect, it } from 'vitest';

import { OUTPUT_CONTRACT, parseFences, safePath } from './fences.ts';

describe('parseFences', () => {
  it('reads several files out of one response', () => {
    const response = [
      'Sure, here you go.',
      '',
      '```ts',
      '// file: src/game.ts',
      'export default 1;',
      '```',
      '',
      '```ts',
      '// file: src/systems/weapon.ts',
      'export const damage = 20;',
      '```',
    ].join('\n');

    const result = parseFences(response);
    expect(result.files.map((f) => f.path)).toEqual(['src/game.ts', 'src/systems/weapon.ts']);
    expect(result.files[0]?.content).toBe('export default 1;\n');
    expect(result.files[1]?.content).toBe('export const damage = 20;\n');
    expect(result.rejected).toEqual([]);
    expect(result.blocks).toBe(2);
  });

  it('accepts the marker above the fence, which is what models actually do', () => {
    const result = parseFences(
      ['// file: src/hud.ts', '```ts', 'export const x = 1;', '```'].join('\n'),
    );
    expect(result.files.map((f) => f.path)).toEqual(['src/hud.ts']);
  });

  it('keeps nested fences inside the file', () => {
    const response = [
      '````ts',
      '// file: src/game.ts',
      '/**',
      ' * ```ts',
      ' * example();',
      ' * ```',
      ' */',
      'export const x = 1;',
      '````',
    ].join('\n');
    const result = parseFences(response);
    expect(result.files).toHaveLength(1);
    expect(result.files[0]?.content).toContain('example();');
  });

  it('ignores a fenced block with no file marker', () => {
    const result = parseFences(['```sh', 'npm run dev', '```'].join('\n'));
    expect(result.files).toEqual([]);
    expect(result.blocks).toBe(1);
  });

  it('rejects a traversal instead of writing it', () => {
    const result = parseFences(
      ['```ts', '// file: src/../../../etc/passwd', 'nope', '```'].join('\n'),
    );
    expect(result.files).toEqual([]);
    expect(result.rejected).toEqual([
      { path: 'src/../../../etc/passwd', reason: 'path traversal (..) rejected' },
    ]);
  });

  it('rejects anything outside src/', () => {
    const result = parseFences(['```json', '// file: package.json', '{}', '```'].join('\n'));
    expect(result.files).toEqual([]);
    expect(result.rejected[0]?.reason).toContain('outside src/');
  });

  it('records a truncated response rather than writing half a file', () => {
    const result = parseFences(['```ts', '// file: src/game.ts', 'export const x = 1;'].join('\n'));
    expect(result.files).toEqual([]);
    expect(result.rejected[0]?.reason).toContain('truncated');
  });

  it('normalises windows separators before checking the root', () => {
    const result = parseFences(
      ['```ts', '// file: src\\systems\\weapon.ts', 'x', '```'].join('\n'),
    );
    expect(result.files[0]?.path).toBe('src/systems/weapon.ts');
  });
});

describe('safePath', () => {
  it.each([
    ['/etc/passwd', 'absolute path rejected'],
    ['C:/Windows/System32/x.ts', 'absolute path (drive letter) rejected'],
    ['src/../../secrets.ts', 'path traversal (..) rejected'],
    ['../src/game.ts', 'path traversal (..) rejected'],
    ['', 'empty path'],
    ['node_modules/three/index.js', 'outside src/'],
  ])('rejects %s', (input, reason) => {
    const verdict = safePath(input);
    expect(typeof verdict).toBe('object');
    expect((verdict as { reason: string }).reason).toContain(reason);
  });

  it.each([
    ['src/game.ts', 'src/game.ts'],
    ['./src/game.ts', 'src/game.ts'],
    ['src//systems//weapon.ts', 'src/systems/weapon.ts'],
    ['`src/game.ts`', 'src/game.ts'],
  ])('accepts %s as %s', (input, expected) => {
    expect(safePath(input)).toBe(expected);
  });

  it('honours a different root', () => {
    expect(safePath('lib/x.ts', 'lib')).toBe('lib/x.ts');
    expect(safePath('src/x.ts', 'lib')).toEqual({
      reason: 'outside lib/ — the game may only edit its own source',
    });
  });
});

describe('OUTPUT_CONTRACT', () => {
  it('shows the exact marker the parser looks for', () => {
    expect(OUTPUT_CONTRACT).toContain('// file: src/game.ts');
    const parsed = parseFences(OUTPUT_CONTRACT);
    // The contract's own example is a valid block, which is the point.
    expect(parsed.files[0]?.path).toBe('src/game.ts');
  });
});
