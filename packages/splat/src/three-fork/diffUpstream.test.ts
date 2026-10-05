/**
 * The fork-drift guard, as a test as well as a `pretest` hook.
 *
 * `npm test -w packages/splat` runs `scripts/diff-upstream.mjs` before vitest, but the whole
 * suite is usually run from the repository root as plain `vitest`, which skips lifecycle
 * scripts. A fork that silently diverges from the three it is pinned to is the single most
 * expensive failure this package can have, so the check runs both ways.
 */
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const SCRIPT = fileURLToPath(new URL('../../scripts/diff-upstream.mjs', import.meta.url));

describe('diff-upstream', () => {
  it('passes: the fork is upstream plus its marked edits, nothing else', () => {
    let output = '';
    expect(() => {
      output = execFileSync(process.execPath, [SCRIPT], { encoding: 'utf8' });
    }).not.toThrow();
    expect(output).toContain('diff-upstream ok');
    expect(output).toContain('three@0.186.0');
  });

  it('reports which edits are present, so a lost block is visible in the log', () => {
    const output = execFileSync(process.execPath, [SCRIPT], { encoding: 'utf8' });
    // Edit numbers are the plan's; 2, 5, 7 and 10 are deliberately absent (see UPSTREAM.md).
    for (const edit of ['0×', '1×', '4×', '6×', '8×', '9×', '11×']) {
      expect(output).toContain(edit);
    }
  });
});
