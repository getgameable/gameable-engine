import { describe, expect, it } from 'vitest';

import { createTextLimit, TextLimit } from './TextLimit.js';

describe('TextLimit', () => {
  it('passes the burst, then tells once and refuses quietly after', () => {
    const limit = new TextLimit({ burst: 2, refill: 1, everyMs: 1000 });
    expect([0, 0, 0, 0, 0].map((now) => limit.spend(now))).toEqual([
      'pass',
      'pass',
      'tell',
      'refuse',
      'refuse',
    ]);
    expect(limit.counts).toEqual({ spent: 2, oversize: 0, bad: 0, overBudget: 3 });
  });

  it('tells again only after a frame has passed in between', () => {
    const limit = createTextLimit({ burst: 1, refill: 1, everyMs: 1000 });
    expect([limit.spend(0), limit.spend(0), limit.spend(0)]).toEqual(['pass', 'tell', 'refuse']);
    expect(limit.spend(1000)).toBe('pass'); // a token came back
    expect([limit.spend(1000), limit.spend(1000)]).toEqual(['tell', 'refuse']);
  });

  it('closes on the closeAfter-th refusal in a row: sustained abuse', () => {
    const limit = new TextLimit({ burst: 1, refill: 1, everyMs: 1000, closeAfter: 4 });
    limit.spend(0);
    expect([1, 2, 3, 4].map(() => limit.spend(0))).toEqual(['tell', 'refuse', 'refuse', 'close']);
  });

  it('does not close a client whose refusals are broken up by passing frames', () => {
    const limit = new TextLimit({ burst: 1, refill: 1, everyMs: 1000, closeAfter: 3 });
    const verdicts: string[] = [];
    for (let second = 0; second < 10; second += 1) {
      for (let i = 0; i < 3; i += 1) verdicts.push(limit.spend(second * 1000)); // 3 a second, 1 allowed
    }
    expect(verdicts).not.toContain('close');
    expect(verdicts.filter((v) => v === 'tell')).toHaveLength(10);
  });

  it('defaults to 40, +20 per 5 s, and closes after 100 refusals in a row', () => {
    const limit = new TextLimit();
    const verdicts = Array.from({ length: 140 }, () => limit.spend(0));
    expect(verdicts.filter((v) => v === 'pass')).toHaveLength(40);
    expect(verdicts.indexOf('tell')).toBe(40);
    expect(verdicts.indexOf('close')).toBe(139);
    expect(limit.spend(5000)).toBe('pass');
  });

  it('counts refusals by kind: size and payload are oversize, the rest bad', () => {
    const limit = new TextLimit();
    limit.refused('payload');
    limit.refused('size');
    limit.refused('json');
    limit.refused('shape');
    expect(limit.counts).toEqual({ spent: 0, oversize: 2, bad: 2, overBudget: 0 });
  });

  it('refuses a nonsense closeAfter', () => {
    expect(() => new TextLimit({ closeAfter: 0 })).toThrow(RangeError);
    expect(() => new TextLimit({ closeAfter: Number.NaN })).toThrow(RangeError);
  });
});
