import { spawnSync } from 'node:child_process';
import process from 'node:process';
import { fileURLToPath, URL } from 'node:url';

import { describe, expect, it } from 'vitest';

const GEN = fileURLToPath(new URL('../scripts/gen-entries.mjs', import.meta.url));

describe('the gameable package', () => {
  it('has a subpath for every workspace export, and its generated files are current', () => {
    const result = spawnSync(process.execPath, [GEN, '--check'], { encoding: 'utf8' });
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
  });
});
