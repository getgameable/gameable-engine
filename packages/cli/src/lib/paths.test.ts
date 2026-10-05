import { describe, expect, it } from 'vitest';

import { absPosix, isAbsolutePath, relativeSpecifier, toPosix } from './paths.js';

describe('toPosix', () => {
  it('forward-slashes a Windows path', () => {
    expect(toPosix('F:\\work\\aos\\gameable')).toBe('F:/work/aos/gameable');
  });

  it('drops a trailing separator', () => {
    expect(toPosix('F:\\work\\aos\\')).toBe('F:/work/aos');
    expect(toPosix('/home/me/')).toBe('/home/me');
  });

  it('keeps a bare drive root usable', () => {
    expect(toPosix('C:\\')).toBe('C:/');
  });

  it('leaves an already-posix path alone', () => {
    expect(toPosix('/usr/local/lib')).toBe('/usr/local/lib');
  });

  it('handles a UNC path', () => {
    expect(toPosix('\\\\server\\share\\game')).toBe('//server/share/game');
  });
});

const onWindows = process.platform === 'win32';

describe('absPosix', () => {
  it.runIf(onWindows)('always returns an absolute, forward-slashed path', () => {
    const result = absPosix('F:\\work\\aos\\gameable', 'packages\\cli');
    expect(result).toBe('F:/work/aos/gameable/packages/cli');
    expect(result).not.toContain('\\');
    expect(isAbsolutePath(result)).toBe(true);
  });

  it.runIf(onWindows)('resolves a relative segment', () => {
    expect(absPosix('F:/a/b/c', '../..')).toBe('F:/a');
  });

  it('is absolute and slash-free on any platform', () => {
    const result = absPosix('a', 'b');
    expect(isAbsolutePath(result)).toBe(true);
    expect(result).not.toContain('\\');
  });
});

describe('relativeSpecifier', () => {
  it('walks up and back down', () => {
    expect(relativeSpecifier('F:/game/.gameable', 'F:/game/src/game.ts')).toBe('../src/game.ts');
  });

  it('prefixes ./ for a sibling', () => {
    expect(relativeSpecifier('F:/game/build', 'F:/game/build/entry.ts')).toBe('./entry.ts');
  });

  it('crosses out of the game directory', () => {
    expect(relativeSpecifier('F:/game/.gameable', 'F:/repo/packages/sdk/src/wit/entry.ts')).toBe(
      '../../repo/packages/sdk/src/wit/entry.ts',
    );
  });

  it('falls back to an absolute path across Windows drives', () => {
    expect(relativeSpecifier('C:/temp/work', 'F:/repo/packages/sdk/src/wit/entry.ts')).toBe(
      'F:/repo/packages/sdk/src/wit/entry.ts',
    );
  });

  it('never emits a backslash', () => {
    const spec = relativeSpecifier('F:\\game\\.gameable', 'F:\\game\\src\\game.ts');
    expect(spec).toBe('../src/game.ts');
  });
});

describe('isAbsolutePath', () => {
  it('accepts both separator styles for a drive letter', () => {
    expect(isAbsolutePath('F:/work')).toBe(true);
    expect(isAbsolutePath('F:\\work')).toBe(true);
  });

  it('rejects a relative path', () => {
    expect(isAbsolutePath('src/game.ts')).toBe(false);
    expect(isAbsolutePath('./src')).toBe(false);
  });
});
