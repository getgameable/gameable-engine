/**
 * `Budget` — a token bucket for one connection's inbound frames.
 */

/** What a {@link Budget} allows. */
export interface BudgetOptions {
  /** The most tokens it holds, and how many it starts with. Default 40. */
  burst?: number;
  /** Tokens added each period. Default 20. */
  refill?: number;
  /** The length of a period, in milliseconds. Default 5000. */
  everyMs?: number;
}

/**
 * A token bucket: it starts full at `burst` tokens, `take` spends one, and
 * `refill` tokens come back for every whole `everyMs` that has passed, never
 * past `burst`. The clock is the caller's `now`, so a test steps time by hand;
 * a `now` that goes backwards earns nothing. Time left over after a refill
 * carries to the next one. One instance per connection; it allocates nothing.
 *
 * @example
 * ```ts
 * import { Budget } from 'gameable/net/server';
 *
 * const budget = new Budget({ burst: 2, refill: 1, everyMs: 1000 });
 * const spent = [budget.take(0), budget.take(0), budget.take(0)]; // [true, true, false]
 * const later = budget.take(1000); // true: one token came back
 * ```
 */
export class Budget {
  private readonly burst: number;
  private readonly refill: number;
  private readonly everyMs: number;
  private tokens: number;
  private last = Number.NaN;

  /**
   * @param options - The bucket's size and refill rate; see {@link BudgetOptions}.
   */
  constructor(options: BudgetOptions = {}) {
    this.burst = options.burst ?? 40;
    this.refill = options.refill ?? 20;
    this.everyMs = options.everyMs ?? 5000;
    this.tokens = this.burst;
  }

  /**
   * Spends one token if there is one.
   *
   * @param now - The current time in milliseconds, from any monotonic clock.
   * @returns True when the frame is within budget, false when it should be refused.
   */
  take(now: number): boolean {
    if (Number.isNaN(this.last)) this.last = now;
    const periods = Math.floor((now - this.last) / this.everyMs);
    if (periods > 0) {
      this.tokens = Math.min(this.burst, this.tokens + periods * this.refill);
      this.last += periods * this.everyMs;
    }
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}

/**
 * A new budget.
 *
 * @param options - The bucket's size and refill rate; defaults 40, 20 per 5 s.
 * @returns The budget.
 *
 * @example
 * ```ts
 * import { createBudget } from 'gameable/net/server';
 *
 * const budget = createBudget();
 * const ok = budget.take(Date.now()); // true
 * ```
 */
export function createBudget(options?: BudgetOptions): Budget {
  return new Budget(options);
}
