/**
 * TSDoc hygiene the API pages and the llms bundles depend on (the multiplayer docs review).
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { ROOT } from './gen-llms.mjs';

/** Directories that hold generated or vendored code, not authored doc comments. */
const SKIP = new Set(['node_modules', 'dist', 'build', 'generated', 'vendor']);

/**
 * @param {string} dir Absolute directory.
 * @returns {string[]} Absolute paths of the `.ts` files under it.
 */
function tsFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const path = join(dir, e.name);
    if (e.isDirectory()) return SKIP.has(e.name) ? [] : tsFiles(path);
    return e.name.endsWith('.ts') ? [path] : [];
  });
}

describe('doc comments in packages/*/src', () => {
  it('have no line without its leading `*` (a `\\n` expanded inside a comment)', () => {
    const bad = [];
    for (const file of tsFiles(join(ROOT, 'packages'))) {
      if (!file.replaceAll('\\', '/').includes('/src/')) continue;
      const text = readFileSync(file, 'utf8');
      for (const block of text.matchAll(/\/\*\*[\s\S]*?\*\//g)) {
        for (const line of block[0].split('\n').slice(1)) {
          if (!/^\s*\*/.test(line)) bad.push(`${file.slice(ROOT.length)}: ${JSON.stringify(line)}`);
        }
      }
    }
    expect(bad).toEqual([]);
  });
});
