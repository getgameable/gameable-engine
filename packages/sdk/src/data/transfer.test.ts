import { describe, expect, it } from 'vitest';

import { applyTransfer } from './transfer';

describe('applyTransfer', () => {
  it('moves numbers and listed items both ways', () => {
    const out = applyTransfer(
      { coins: 10, owned: ['a', 'b'] },
      { coins: 1, owned: ['c'] },
      { coins: 4, owned: ['a'] },
      { owned: ['c'] },
    );
    expect(out).toEqual({
      a: { coins: 6, owned: ['b', 'c'] },
      b: { coins: 5, owned: ['a'] },
    });
  });

  it('treats a missing document as empty, and creates the fields it fills', () => {
    expect(applyTransfer({ coins: 3 }, null, { coins: 3 }, {})).toEqual({
      a: { coins: 0 },
      b: { coins: 3 },
    });
  });

  it('refuses what a side does not have, a negative amount, or a non-object document', () => {
    expect(applyTransfer({ coins: 2 }, {}, { coins: 3 }, {})).toBeNull();
    expect(applyTransfer({ owned: ['a'] }, {}, { owned: ['z'] }, {})).toBeNull();
    expect(applyTransfer({ coins: 2 }, {}, { coins: -1 }, {})).toBeNull();
    expect(applyTransfer([1], {}, {}, {})).toBeNull();
    expect(applyTransfer({}, {}, { coins: 'x' }, {})).toBeNull();
  });

  it('moves object items by value, whatever their key order, and refuses one not held', () => {
    const cat = { id: 'p1', kind: 'cat', tier: 1 };
    const out = applyTransfer(
      { pets: [{ tier: 1, kind: 'cat', id: 'p1' }] },
      { pets: [] },
      { pets: [JSON.parse(JSON.stringify(cat)) as unknown] },
      {},
    );
    expect(out).toEqual({ a: { pets: [] }, b: { pets: [cat] } });
    expect(applyTransfer({ pets: [cat] }, {}, { pets: [{ ...cat, tier: 2 }] }, {})).toBeNull();
  });

  it('never touches its inputs', () => {
    const a = { coins: 5, owned: ['a'] };
    applyTransfer(a, {}, { coins: 1, owned: ['a'] }, {});
    expect(a).toEqual({ coins: 5, owned: ['a'] });
  });
});
