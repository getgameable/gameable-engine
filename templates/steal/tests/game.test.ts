/**
 * The heist, driven headlessly as a room's authority over a memory store
 * (`tests/heist.ts`): saved wallets kept at join, income, a steal as one
 * exchange, the save on leave, offline income and its cap, the shield, the
 * belt and the rebirth.
 */
import { describe, expect, it } from 'vitest';

import game from '../src/game';
import { BASES, BELT_START } from '../src/ring';
import { bootHeist, GAME, type TestHeist } from './heist';

/**
 * @param heist A heist.
 * @param key A store key.
 * @param doc Their saved document.
 */
async function saved(heist: TestHeist, key: string, doc: unknown): Promise<void> {
  await heist.store.save(GAME, key, JSON.stringify(doc), 0);
}

/**
 * @param heist A heist.
 * @param tag A command tag.
 * @returns Every command with that tag, in order.
 */
function sent(heist: TestHeist, tag: string): { tag: string; val: unknown }[] {
  return heist.commands.filter((c) => c.tag === tag);
}

describe('the wallet', () => {
  it('a player who joins with { coins: 10, owned: [a] } keeps it, on the authority and in the store', async () => {
    const h = bootHeist();
    await saved(h, 'u1', { coins: 10, owned: ['a'] });
    await h.join(0, 'u1');
    h.run(2);
    await h.settle();
    expect(h.wallet(0)).toEqual({ coins: 10, owned: ['a'], shieldUntil: 0, rebirths: 0 });
    expect(await h.stored('u1')).toEqual(h.wallet(0));
  });

  it('pays income per owned brainrot every incomeSeconds', async () => {
    expect(game.rules?.incomeSeconds).toBe(10);
    const h = bootHeist({ rules: { incomeSeconds: 1 } });
    await saved(h, 'u1', { coins: 10, owned: ['a', 'b'] });
    await h.join(0, 'u1');
    h.run(60 * 3 + 2);
    expect(h.wallet(0).coins).toBe(16); // 3 payouts of 2
  });

  it('leaving flushes the save the 6 s throttle was holding back', async () => {
    const h = bootHeist({ rules: { incomeSeconds: 1 } });
    await saved(h, 'u1', { coins: 0, owned: ['a'] });
    await h.join(0, 'u1');
    h.run(1);
    await h.settle(); // the join's save is written
    h.run(60 * 2 + 1);
    await h.settle();
    expect(h.wallet(0).coins).toBe(2);
    expect((await h.stored('u1'))?.coins).toBe(0); // written at join; the payouts wait
    await h.leave(0);
    expect((await h.stored('u1'))?.coins).toBe(2);
  });
});

describe('offline income', () => {
  it('pays for the time away by the server clock, capped at offlineCapHours', async () => {
    const hour = 3600 * 1000;
    for (const [away, coins] of [
      [1, 360], // one hour: 360 payouts of 1
      [20, 2880], // twenty hours count as eight
    ]) {
      const h = bootHeist({ now: () => Date.now() + away * hour });
      await saved(h, 'u1', { coins: 0, owned: ['a'] });
      await h.join(0, 'u1');
      h.run(2);
      expect(h.wallet(0).coins).toBe(coins);
      expect(sent(h, 'send').map((c) => c.val)).toContainEqual(
        expect.objectContaining({ name: 'away', payload: JSON.stringify({ coins }), to: 0 }),
      );
    }
  });
});

describe('stealing', () => {
  it('standing in another base for 3 s moves the newest id between the documents through one exchange', async () => {
    const h = bootHeist();
    await saved(h, 'u1', { coins: 0, owned: ['a', 'b'] });
    await saved(h, 'u2', { coins: 0, owned: [] });
    await h.join(0, 'u1');
    await h.join(1, 'u2');
    h.run(2);
    h.place(1, BASES[0].x, BASES[0].z);
    h.run(60 * 2);
    expect(sent(h, 'exchange')).toHaveLength(0); // two seconds is not enough
    h.run(62);
    expect(sent(h, 'exchange').map((c) => c.val)).toEqual([
      expect.objectContaining({ a: 1, b: 0, give: '{}', take: '{"owned":["b"]}' }),
    ]);
    await h.settle();
    h.run(1); // the exchange-result lands
    expect(h.wallet(0).owned).toEqual(['a']);
    expect(h.wallet(1).owned).toEqual(['b']);
    expect((await h.stored('u1'))?.owned).toEqual(['a']);
    expect((await h.stored('u2'))?.owned).toEqual(['b']);
    const stolen = sent(h, 'send').filter((c) => (c.val as { name: string }).name === 'stolen');
    expect(
      stolen.map((c) => JSON.parse((c.val as { payload: string }).payload) as unknown),
    ).toEqual([{ thief: 1, victim: 0, id: 'b' }]);
    expect(h.logs).toEqual([]);
  });

  it('a shield blocks the steal, and costs shieldCost coins', async () => {
    const h = bootHeist();
    await saved(h, 'u1', { coins: 20, owned: ['a'] });
    await h.join(0, 'u1');
    await h.join(1, 'u2');
    h.run(2, (frame, tape) => {
      if (frame === 0) tape.message(0, 'shield');
    });
    expect(h.wallet(0).coins).toBe(10);
    expect(h.wallet(0).shieldUntil).toBeGreaterThan(Date.now());
    h.place(1, BASES[0].x, BASES[0].z);
    h.run(60 * 4);
    await h.settle();
    h.run(1);
    expect(sent(h, 'exchange')).toHaveLength(0);
    expect(h.wallet(0).owned).toEqual(['a']);
  });
});

describe('the belt and the rebirth', () => {
  it('walking into a brainrot on the belt adds its id to your wallet', async () => {
    const h = bootHeist();
    await h.join(0, 'u1');
    h.run(1); // the first brainrot appears at the start of the belt
    h.place(0, BELT_START + 1.2, 0); // where it rides to in a second
    h.run(70);
    const owned = h.wallet(0).owned;
    expect(owned).toHaveLength(1);
    expect(owned[0]).toMatch(/^tralalero-/);
    const room = sent(h, 'send').map((c) => (c.val as { name: string }).name);
    expect(room).toContain('grabbed');
    expect(room).toContain('aos:phase');
  });

  it('a rebirth with rebirthCost coins resets the wallet for a higher multiplier', async () => {
    const h = bootHeist({ rules: { incomeSeconds: 1 } });
    await saved(h, 'u1', { coins: 100, owned: ['a', 'b'] });
    await h.join(0, 'u1');
    h.run(2, (frame, tape) => {
      if (frame === 0) tape.message(0, 'rebirth');
    });
    expect(h.wallet(0)).toEqual({ coins: 0, owned: [], shieldUntil: 0, rebirths: 1 });
    await saved(h, 'u2', { coins: 0, owned: ['a', 'b'], rebirths: 1 });
    await h.join(1, 'u2');
    h.run(62);
    expect(h.wallet(1).coins).toBe(3); // 2 brainrots x 1.5
  });
});
