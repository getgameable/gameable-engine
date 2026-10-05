import { describe, expect, it } from 'vitest';

import { createInputFacade } from './input';
import { makeLanes } from './inputLanes';
import { keyIndex, keyIndex2 } from './keycodes';

/** The node globals the allocation check needs, typed narrowly (the SDK has no node types). */
const nodeEnv = globalThis as unknown as {
  gc?: () => void;
  process?: { memoryUsage: () => { heapUsed: number } };
};

/** @returns Bytes of JS heap in use, after a full GC when the runner exposes one. */
function heapUsed(): number {
  nodeEnv.gc?.();
  return nodeEnv.process?.memoryUsage().heapUsed ?? 0;
}

/** Calls per measured window. */
const CALLS = 20_000;

describe('key lookups', () => {
  it('keep the lower-case letter and F-key spellings, and nothing else', () => {
    expect(keyIndex('w')).toBe(keyIndex('KeyW'));
    expect(keyIndex('f1')).toBe(keyIndex('F1'));
    expect(keyIndex('keyw')).toBe(-1);
    expect(keyIndex('shift')).toBe(-1);
    expect(keyIndex2('Shift')).toBe(keyIndex('ShiftRight'));
    expect(keyIndex2('W')).toBe(-1);
  });

  it('isDown on a key that is not held allocates nothing', () => {
    const lanes = makeLanes();
    const input = createInputFacade(() => lanes);
    let hits = 0;
    for (let i = 0; i < CALLS; i += 1) if (input.isDown('W') || input.pressed('w')) hits += 1;
    // Median of five windows: a scavenge inside one window hides its garbage.
    // A string per miss (the old toUpperCase fallback) is ~24 bytes per call,
    // about 960 KB per window (measured in the 3.12b review).
    const growth: number[] = [];
    for (let w = 0; w < 5; w += 1) {
      const before = heapUsed();
      for (let i = 0; i < CALLS; i += 1) if (input.isDown('W') || input.pressed('w')) hits += 1;
      growth.push(heapUsed() - before);
    }
    growth.sort((a, b) => a - b);
    expect(growth[2]).toBeLessThan(100_000);
    expect(hits).toBe(0);
  });
});
