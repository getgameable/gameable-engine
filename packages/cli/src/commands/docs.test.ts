/**
 * `gameable docs` lists every llms bundle the generator writes.
 */
import { describe, expect, it } from 'vitest';

import { BUNDLES, bundleForAlias } from './docs.js';

/** The generator's own list, a plain script outside this package. */
const BUDGETS = new URL('../../../../tools/docs/llms/budgets.mjs', import.meta.url).href;

describe('gameable docs', () => {
  it('lists every bundle in tools/docs/llms/budgets.mjs, and nothing else', async () => {
    const { OUTPUTS } = (await import(BUDGETS)) as { OUTPUTS: string[] };
    expect(BUNDLES.map((bundle) => bundle.name).sort()).toEqual([...OUTPUTS].sort());
  });

  it('finds a kit bundle by the kit name', () => {
    expect(bundleForAlias('mystery')).toBe('llms-mystery.txt');
    expect(bundleForAlias('Brawl')).toBe('llms-brawl.txt');
    expect(bundleForAlias('nope')).toBeUndefined();
  });
});
