/**
 * `TextLimit` — one player's text-frame rule, shared by both rooms: the
 * budget, what to do when it runs out, and per-player counts.
 */
import { Budget, type BudgetOptions } from './Budget.js';
import type { BadReason } from './InboundParser.js';

/** What a {@link TextLimit} allows; the budget's fields plus when to give up. */
export interface TextLimitOptions extends BudgetOptions {
  /**
   * Refusals in a row, with no frame passing between them, at which the
   * client is closed. Default 100: at the default refill (20 at once every
   * 5 s) a steady sender refuses 5r - 20 frames per window, so it is closed at
   * 24 frames a second or more (measured: 23/s never is, 24/s at about 10 s).
   */
  closeAfter?: number;
}

/** One player's text frames: passed, refused by the parser, refused by the budget. */
export interface TextCounts {
  /** Frames within budget: handed to the parser, which may still refuse them. */
  spent: number;
  /** Refused as too big: a frame over the frame cap or a `msg` payload over `MAX_PAYLOAD_BYTES`. */
  oversize: number;
  /** Refused by the parser for anything else (JSON, type, shape, depth...). */
  bad: number;
  /** Refused by the budget, before parsing. */
  overBudget: number;
}

/**
 * What to do with a text frame: `pass` (parse it), `tell` (refuse it and send
 * `error: budget`: the first refusal of a run), `refuse` (refuse it quietly)
 * or `close` (refuse it and close the client).
 */
export type TextVerdict = 'pass' | 'tell' | 'refuse' | 'close';

/**
 * A player's text budget with the room's rule around it. Every text frame
 * calls {@link TextLimit.spend} before it is parsed (a frame the parser then
 * refuses has still cost a token). When the budget runs out the player is
 * told once (`tell`) and later frames are dropped (`refuse`); a frame that
 * passes ends the run, so the next run tells again. Only sustained abuse,
 * `closeAfter` refusals in a row, closes the client (`close`). Input frames
 * have their own budget and rule (the Colyseus room closes an input flood at
 * once; our own `Room` has no input budget).
 * Allocates nothing.
 *
 * @example
 * ```ts
 * import { TextLimit } from 'gameable/net/server';
 *
 * const limit = new TextLimit({ burst: 1, refill: 1, everyMs: 1000 });
 * const verdicts = [limit.spend(0), limit.spend(0), limit.spend(0)]; // ['pass', 'tell', 'refuse']
 * ```
 */
export class TextLimit {
  /** What this player sent and what was refused. */
  readonly counts: TextCounts = { spent: 0, oversize: 0, bad: 0, overBudget: 0 };
  private readonly budget: Budget;
  private readonly closeAfter: number;
  private run = 0;

  /**
   * @param options - The budget (default 40, +20 per 5 s) and `closeAfter` (default 100).
   * @throws {RangeError} When `closeAfter` is not a whole number of at least 1.
   */
  constructor(options: TextLimitOptions = {}) {
    const closeAfter = options.closeAfter ?? 100;
    if (!Number.isInteger(closeAfter) || closeAfter < 1) {
      throw new RangeError(
        `TextLimit: closeAfter must be a whole number >= 1, not ${String(closeAfter)}`,
      );
    }
    this.closeAfter = closeAfter;
    this.budget = new Budget(options);
  }

  /**
   * Spend one token for a text frame that just arrived.
   *
   * @param now - The current time in milliseconds, from any monotonic clock.
   * @returns The verdict; see {@link TextVerdict}.
   */
  spend(now: number): TextVerdict {
    if (this.budget.take(now)) {
      this.run = 0;
      this.counts.spent += 1;
      return 'pass';
    }
    this.counts.overBudget += 1;
    this.run += 1;
    if (this.run >= this.closeAfter) return 'close';
    return this.run === 1 ? 'tell' : 'refuse';
  }

  /**
   * Count a frame that passed the budget and was then refused.
   *
   * @param reason - Why: the parser's `BadReason`s `size` and `payload` count
   *   as oversize; any other reason (a room's own, such as `hello`) as bad.
   */
  refused(reason: BadReason | (string & {})): void {
    if (reason === 'size' || reason === 'payload') this.counts.oversize += 1;
    else this.counts.bad += 1;
  }
}

/**
 * A new text limit.
 *
 * @param options - The budget and `closeAfter`; defaults 40, +20 per 5 s, 100.
 * @returns The limit.
 *
 * @example
 * ```ts
 * import { createTextLimit } from 'gameable/net/server';
 *
 * const limit = createTextLimit();
 * const verdict = limit.spend(performance.now()); // 'pass'
 * ```
 */
export function createTextLimit(options?: TextLimitOptions): TextLimit {
  return new TextLimit(options);
}
