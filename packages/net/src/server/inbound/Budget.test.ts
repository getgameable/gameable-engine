import { describe, expect, it } from 'vitest';

import { Budget, createBudget } from './Budget.js';

function drain(budget: Budget, now: number): number {
  let taken = 0;
  while (budget.take(now)) taken += 1;
  return taken;
}

describe('Budget', () => {
  it('allows the burst of 40 and then refuses', () => {
    const budget = new Budget();
    expect(drain(budget, 0)).toBe(40);
    expect(budget.take(0)).toBe(false);
  });

  it('refills 20 every 5 seconds', () => {
    const budget = createBudget();
    drain(budget, 0);
    expect(budget.take(4999)).toBe(false);
    expect(drain(budget, 5000)).toBe(20);
    expect(drain(budget, 9999)).toBe(0);
    expect(drain(budget, 10_000)).toBe(20);
  });

  it('takes the options it is given', () => {
    const budget = createBudget({ burst: 2, refill: 1, everyMs: 100 });
    expect(drain(budget, 0)).toBe(2);
    expect(drain(budget, 100)).toBe(1);
  });

  it('never holds more than the burst after a long idle', () => {
    const budget = new Budget();
    drain(budget, 0);
    expect(drain(budget, 10_000_000)).toBe(40);
  });

  it('does not mint tokens when now goes backwards', () => {
    const budget = new Budget();
    drain(budget, 10_000);
    expect(budget.take(0)).toBe(false);
    expect(budget.take(5_000)).toBe(false);
    expect(budget.take(10_000)).toBe(false);
    expect(drain(budget, 15_000)).toBe(20);
  });

  it('keeps a partial period when it refills, so no time is lost', () => {
    const budget = new Budget({ burst: 4, refill: 2, everyMs: 100 });
    drain(budget, 0);
    expect(drain(budget, 150)).toBe(2);
    expect(drain(budget, 200)).toBe(2);
  });
});
