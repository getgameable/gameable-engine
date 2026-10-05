/**
 * The exchange half of the store contract (`storeContract.ts` registers it):
 * both changes or neither, under races too.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { ContractScope } from './storeContract.js';
import type { ExchangeApply } from './types.js';

const read = (text: string | null): { coins: number; owned: string[] } =>
  text === null
    ? { coins: 0, owned: [] }
    : (JSON.parse(text) as { coins: number; owned: string[] });

/** Moves item `id` from b to a for `price` coins from a to b. */
const buy =
  (id: string, price: number): ExchangeApply =>
  (docA, docB) => {
    const a = read(docA);
    const b = read(docB);
    if (!b.owned.includes(id) || a.coins < price) return null;
    const next = {
      a: { coins: a.coins - price, owned: [...a.owned, id] },
      b: { coins: b.coins + price, owned: b.owned.filter((o) => o !== id) },
    };
    return { a: JSON.stringify(next.a), b: JSON.stringify(next.b) };
  };

/** Registers the exchange tests on the contract's scope. */
export function contractExchanges(scope: ContractScope): void {
  describe('exchange', () => {
    exchangeTests(scope);
  });
}

function exchangeTests(scope: ContractScope): void {
  const doc = async (player: string): Promise<unknown> => {
    const d = await scope.store.load(scope.game, player);
    return d === null ? null : { version: d.version, ...(JSON.parse(d.data) as object) };
  };
  beforeEach(async () => {
    await scope.store.save(scope.game, 'a', '{"coins":10,"owned":[]}', 0);
    await scope.store.save(scope.game, 'b', '{"coins":0,"owned":["gem"]}', 0);
  });

  it('applies both changes of an exchange and bumps both versions', async () => {
    const result = await scope.store.exchange(
      scope.game,
      'a',
      'b',
      buy('gem', 4),
      { a: 1, b: 1 },
      { give: '4', take: '"gem"' },
    );
    expect(result).toEqual({ ok: true, versions: { a: 2, b: 2 } });
    expect(await doc('a')).toEqual({ version: 2, coins: 6, owned: ['gem'] });
    expect(await doc('b')).toEqual({ version: 2, coins: 4, owned: [] });
  });

  it('hands apply null for a player with no document, at expected version 0', async () => {
    const seen: (string | null)[] = [];
    const apply: ExchangeApply = (docA, docB) => {
      seen.push(docA, docB);
      return { a: '{"coins":1,"owned":[]}', b: '{"coins":2,"owned":[]}' };
    };
    expect(await scope.store.exchange(scope.game, 'new', 'b', apply, { a: 0, b: 1 })).toEqual({
      ok: true,
      versions: { a: 1, b: 2 },
    });
    expect(seen[0]).toBeNull();
    expect(read(seen[1] ?? null).owned).toEqual(['gem']);
    expect(await doc('new')).toEqual({ version: 1, coins: 1, owned: [] });
  });

  it('refuses when apply returns null and changes nothing', async () => {
    const result = await scope.store.exchange(scope.game, 'a', 'b', buy('sword', 4), {
      a: 1,
      b: 1,
    });
    expect(result).toEqual({ ok: false, reason: 'refused' });
    expect(await doc('a')).toEqual({ version: 1, coins: 10, owned: [] });
    expect(await doc('b')).toEqual({ version: 1, coins: 0, owned: ['gem'] });
  });

  it('refuses when apply throws and leaves both untouched', async () => {
    const boom: ExchangeApply = () => {
      throw new Error('a game bug');
    };
    expect(await scope.store.exchange(scope.game, 'a', 'b', boom, { a: 1, b: 1 })).toEqual({
      ok: false,
      reason: 'refused',
    });
    expect(await doc('a')).toEqual({ version: 1, coins: 10, owned: [] });
    expect(await doc('b')).toEqual({ version: 1, coins: 0, owned: ['gem'] });
  });

  it('refuses an exchange of a player with themself without calling apply', async () => {
    let calls = 0;
    const apply: ExchangeApply = () => {
      calls += 1;
      return { a: '{}', b: '{}' };
    };
    expect(await scope.store.exchange(scope.game, 'a', 'a', apply, { a: 1, b: 1 })).toEqual({
      ok: false,
      reason: 'refused',
    });
    expect(calls).toBe(0);
  });

  it('makes a stale expected.a stale and changes nothing', async () => {
    expect(await scope.store.exchange(scope.game, 'a', 'b', buy('gem', 4), { a: 0, b: 1 })).toEqual(
      { ok: false, reason: 'stale' },
    );
    expect(await scope.store.exchange(scope.game, 'a', 'b', buy('gem', 4), { a: 1, b: 5 })).toEqual(
      { ok: false, reason: 'stale' },
    );
    expect(await doc('a')).toEqual({ version: 1, coins: 10, owned: [] });
    expect(await doc('b')).toEqual({ version: 1, coins: 0, owned: ['gem'] });
  });

  it('refuses an exchange whose result is over the size cap, or not JSON, and changes nothing', async () => {
    const huge: ExchangeApply = () => ({
      a: '{"coins":1}',
      b: JSON.stringify({ x: 'x'.repeat(70 * 1024) }),
    });
    expect(await scope.store.exchange(scope.game, 'a', 'b', huge, { a: 1, b: 1 })).toEqual({
      ok: false,
      reason: 'size',
    });
    const broken: ExchangeApply = () => ({ a: '{"coins":1}', b: '{' });
    expect(await scope.store.exchange(scope.game, 'a', 'b', broken, { a: 1, b: 1 })).toEqual({
      ok: false,
      reason: 'invalid',
    });
    expect(await doc('a')).toEqual({ version: 1, coins: 10, owned: [] });
  });

  it('lets exactly one of an exchange and a save racing on the same player win', async () => {
    await Promise.all([scope.store.load(scope.game, 'a'), scope.store.load(scope.game, 'b')]); // two warm connections
    const [traded, saved] = await Promise.all([
      scope.store.exchange(scope.game, 'a', 'b', buy('gem', 4), { a: 1, b: 1 }),
      scope.store.save(scope.game, 'a', '{"coins":99,"owned":[]}', 1),
    ]);
    expect([traded.ok, saved.ok].filter(Boolean)).toHaveLength(1);
    if (saved.ok) {
      expect(traded).toEqual({ ok: false, reason: 'stale' });
      expect(await doc('a')).toEqual({ version: 2, coins: 99, owned: [] });
      expect(await doc('b')).toEqual({ version: 1, coins: 0, owned: ['gem'] });
    } else {
      expect(saved).toEqual({ ok: false, reason: 'stale' });
      expect(await doc('a')).toEqual({ version: 2, coins: 6, owned: ['gem'] });
      expect(await doc('b')).toEqual({ version: 2, coins: 4, owned: [] });
    }
  });

  it('settles two opposite exchanges at once: one wins, the other is stale, no deadlock', async () => {
    const give: ExchangeApply = (x, y) => ({ a: x ?? '{}', b: y ?? '{}' });
    // Two loads at once leave a pooled store two open connections, so the exchanges below
    // really run side by side; with one new connection each, the first is usually done first.
    await Promise.all([scope.store.load(scope.game, 'a'), scope.store.load(scope.game, 'b')]);
    const both = await Promise.all([
      scope.store.exchange(scope.game, 'a', 'b', give, { a: 1, b: 1 }),
      scope.store.exchange(scope.game, 'b', 'a', give, { a: 1, b: 1 }),
    ]);
    expect(both.filter((r) => r.ok)).toEqual([{ ok: true, versions: { a: 2, b: 2 } }]);
    expect(both.filter((r) => !r.ok)).toEqual([{ ok: false, reason: 'stale' }]);
    expect((await doc('a')) as { version: number }).toMatchObject({ version: 2 });
    expect((await doc('b')) as { version: number }).toMatchObject({ version: 2 });
  });
}
