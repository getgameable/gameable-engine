import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { findRepoRoot, isUsableTemplate, npmCli, resolveTemplate } from './workspace.ts';

const repoRoot = findRepoRoot();
const scratch = mkdtempSync(join(tmpdir(), 'llm-eval-ws-'));

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

describe('findRepoRoot', () => {
  it('finds the checkout this file lives in', () => {
    expect(existsSync(join(repoRoot, 'wit'))).toBe(true);
    expect(existsSync(join(repoRoot, 'packages', 'sdk'))).toBe(true);
    expect(repoRoot).not.toContain('\\');
  });
});

describe('isUsableTemplate', () => {
  it('rejects a directory with a manifest but no entry point', () => {
    const half = join(scratch, 'half-written');
    mkdirSync(join(half, 'src'), { recursive: true });
    writeFileSync(join(half, 'package.json'), '{}', 'utf8');
    expect(isUsableTemplate(half)).toBe(false);
  });

  it('accepts one with both', () => {
    const whole = join(scratch, 'whole');
    mkdirSync(join(whole, 'src'), { recursive: true });
    writeFileSync(join(whole, 'package.json'), '{}', 'utf8');
    writeFileSync(join(whole, 'src', 'game.ts'), 'export default {};', 'utf8');
    expect(isUsableTemplate(whole)).toBe(true);
  });

  it('rejects a directory that is not there at all', () => {
    expect(isUsableTemplate(join(scratch, 'nothing'))).toBe(false);
  });
});

describe('resolveTemplate', () => {
  it('finds the fps template in this checkout', () => {
    const template = resolveTemplate(repoRoot, 'fps');
    expect(template?.name).toBe('fps');
    expect(template?.dir).toBe(`${repoRoot}/templates/fps`);
  });

  it('returns undefined for a template that is missing or half-written', () => {
    expect(resolveTemplate(repoRoot, 'definitely-not-a-template')).toBeUndefined();
  });

  it('lets --template-dir win', () => {
    const custom = join(scratch, 'custom');
    mkdirSync(custom, { recursive: true });
    writeFileSync(join(custom, 'package.json'), '{}', 'utf8');
    expect(resolveTemplate(repoRoot, 'fps', custom)?.dir).toBe(custom.replaceAll('\\', '/'));
  });

  it('refuses a --template-dir with no manifest', () => {
    expect(() => resolveTemplate(repoRoot, 'fps', join(scratch, 'nothing'))).toThrow(
      'has no package.json',
    );
  });
});

describe('npmCli', () => {
  it('finds npm-cli.js rather than spawning the .cmd shim', () => {
    const cli = npmCli();
    expect(cli.endsWith('npm-cli.js')).toBe(true);
    expect(existsSync(cli)).toBe(true);
  });
});
