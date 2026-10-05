import { describe, expect, it } from 'vitest';

import { defineGame } from './defineGame';
import { createRng } from './rng';
import { createGuest } from './runtime';
import { createStubHost, stubConfig, stubFrame } from './testing';

describe('createRng', () => {
  it('is deterministic for a seed', () => {
    const a = createRng(42);
    const b = createRng(42);
    for (let i = 0; i < 1000; i += 1) expect(a.uint32()).toBe(b.uint32());
  });

  it('diverges for different seeds', () => {
    const a = createRng(1);
    const b = createRng(2);
    let same = 0;
    for (let i = 0; i < 100; i += 1) if (a.uint32() === b.uint32()) same += 1;
    expect(same).toBe(0);
  });

  it('produces floats in [0, 1) and ints in [0, n)', () => {
    const rng = createRng(7);
    for (let i = 0; i < 10_000; i += 1) {
      const f = rng.float();
      expect(f).toBeGreaterThanOrEqual(0);
      expect(f).toBeLessThan(1);
      const n = rng.int(6);
      expect(Number.isInteger(n)).toBe(true);
      expect(n).toBeGreaterThanOrEqual(0);
      expect(n).toBeLessThan(6);
    }
    expect(rng.int(0)).toBe(0);
    const empty: number[] = [];
    expect(rng.pick(empty)).toBeUndefined();
    expect(['a', 'b']).toContain(rng.pick(['a', 'b']));
  });

  it('is reasonably uniform', () => {
    const rng = createRng(99);
    const buckets = new Array<number>(10).fill(0);
    for (let i = 0; i < 100_000; i += 1) buckets[rng.int(10)] += 1;
    for (const count of buckets) {
      expect(count).toBeGreaterThan(9000);
      expect(count).toBeLessThan(11_000);
    }
  });

  it('round-trips its state', () => {
    const rng = createRng(3);
    for (let i = 0; i < 17; i += 1) rng.uint32();
    const saved = rng.save();
    const expected = [rng.uint32(), rng.uint32(), rng.uint32()];
    rng.load(saved);
    expect([rng.uint32(), rng.uint32(), rng.uint32()]).toEqual(expected);
  });

  it('never gets stuck on an all-zero state', () => {
    const rng = createRng(0);
    rng.load({ s0: 0, s1: 0, s2: 0, s3: 0 });
    expect(rng.uint32()).not.toBe(rng.uint32());
  });
});

describe('runtime seeding', () => {
  it('seeds from env.seed(), not from module scope', () => {
    const draws: number[] = [];
    const game = defineGame({
      systems: [
        (ctx) => {
          draws.push(ctx.rng.uint32());
        },
      ],
    });

    const first = createGuest(createStubHost(111), game);
    first.init(stubConfig());
    first.tick(stubFrame(0));
    const a = draws.pop();

    const second = createGuest(createStubHost(222), game);
    second.init(stubConfig());
    second.tick(stubFrame(0));
    const b = draws.pop();

    const third = createGuest(createStubHost(111), game);
    third.init(stubConfig());
    third.tick(stubFrame(0));
    const c = draws.pop();

    expect(a).not.toBe(b);
    expect(a).toBe(c);
  });
});
