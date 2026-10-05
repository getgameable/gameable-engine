import { describe, expect, it, vi } from 'vitest';

import { initCountingSortPatch, isCountingSortPatched } from './sortPatch.js';

/**
 * A stand-in for `CountingSort.prototype`, with upstream's four-call `compute`.
 *
 * @returns A fresh prototype object.
 */
function fakePrototype(): {
  compute: (this: Record<string, unknown>, renderer: { compute: (n: unknown) => void }) => void;
} {
  return {
    compute(renderer) {
      renderer.compute(this._resetNode);
      renderer.compute(this._histogramNode);
      renderer.compute(this._prefixNode);
      renderer.compute(this._scatterNode);
    },
  };
}

/**
 * A sort instance over a prototype, with the four private nodes filled in.
 *
 * @param proto The prototype to inherit from.
 * @returns The instance.
 */
function sortOver(proto: object): Record<string, unknown> {
  const sort = Object.create(proto) as Record<string, unknown>;
  sort._resetNode = { name: 'reset' };
  sort._histogramNode = { name: 'histogram' };
  sort._prefixNode = { name: 'prefix' };
  sort._scatterNode = { name: 'scatter' };
  return sort;
}

describe('initCountingSortPatch', () => {
  it('turns four renderer.compute calls into one, in pass order', () => {
    const proto = fakePrototype();
    expect(initCountingSortPatch(proto)).toBe(true);
    const sort = sortOver(proto);
    const compute = vi.fn();

    (sort as { compute: (r: unknown) => void }).compute({ compute });

    expect(compute).toHaveBeenCalledTimes(1);
    expect(compute).toHaveBeenCalledWith([
      sort._resetNode,
      sort._histogramNode,
      sort._prefixNode,
      sort._scatterNode,
    ]);
  });

  it('falls back to the original four calls when a pass node is missing', () => {
    const proto = fakePrototype();
    initCountingSortPatch(proto);
    const sort = sortOver(proto);
    sort._prefixNode = null;
    const compute = vi.fn();

    (sort as { compute: (r: unknown) => void }).compute({ compute });

    expect(compute).toHaveBeenCalledTimes(4);
  });

  it('is idempotent and reports its own presence', () => {
    const proto = fakePrototype();
    expect(isCountingSortPatched(proto)).toBe(false);
    initCountingSortPatch(proto);
    const once = proto.compute;
    initCountingSortPatch(proto);
    expect(proto.compute).toBe(once);
    expect(isCountingSortPatched(proto)).toBe(true);
  });

  it('patches the real CountingSort prototype', () => {
    expect(initCountingSortPatch()).toBe(true);
    expect(isCountingSortPatched()).toBe(true);
  });
});
