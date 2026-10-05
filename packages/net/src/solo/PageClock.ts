/**
 * `PageClock` — a room clock whose time only moves when it is told to.
 */

/** One pending timer. Entries are pooled, so a running room allocates none. */
interface TimerEntry {
  id: number;
  at: number;
  fn: (() => void) | null;
}

/**
 * Slack in the due-time comparison, in ms: a timer due at `k * (1000 / 60)`
 * by repeated addition must fire when the clock is moved to the same time by
 * multiplication.
 */
const DUE_EPSILON = 1e-6;

/**
 * The `now`, `setTimer` and `clearTimer` of a room that runs in the page. Its
 * time is simulated and moves only through {@link PageClock.advanceTo}, which
 * fires every timer that comes due, in order, each at its own due time. Play
 * Solo moves it by the page's fixed steps, so the room ticks exactly once per
 * page step.
 *
 * @example
 * ```ts
 * import { PageClock } from 'gameable/net/solo';
 *
 * const clock = new PageClock();
 * clock.setTimer(() => console.log('due'), 16);
 * clock.advanceTo(1000 / 60); // fires it
 * ```
 */
export class PageClock {
  private t = 0;
  private nextId = 1;
  private readonly pending: TimerEntry[] = [];
  private readonly free: TimerEntry[] = [];

  /** @returns The simulated time in ms. */
  now(): number {
    return this.t;
  }

  /**
   * @param fn What to call.
   * @param ms Simulated milliseconds from now; may be 0.
   * @returns A handle for {@link PageClock.clearTimer}.
   */
  setTimer(fn: () => void, ms: number): unknown {
    const entry = this.free.pop() ?? { id: 0, at: 0, fn: null };
    entry.id = this.nextId++;
    entry.at = this.t + Math.max(0, ms);
    entry.fn = fn;
    this.pending.push(entry);
    return entry.id;
  }

  /** @param handle A handle `setTimer` returned; an unknown one is ignored. */
  clearTimer(handle: unknown): void {
    for (let i = 0; i < this.pending.length; i += 1) {
      if (this.pending[i].id !== handle) continue;
      this.release(i);
      return;
    }
  }

  /**
   * Move the clock forward to `ms`, firing the timers that come due on the
   * way (including ones a firing timer sets). A time in the past moves
   * nothing.
   *
   * @param ms The new simulated time.
   */
  advanceTo(ms: number): void {
    if (ms <= this.t) return;
    for (;;) {
      const index = this.dueIndex(ms);
      if (index < 0) break;
      const entry = this.pending[index];
      const fn = entry.fn;
      this.t = Math.max(this.t, entry.at);
      this.release(index);
      fn?.();
    }
    this.t = ms;
  }

  /**
   * @param end The advance's end time.
   * @returns The index of the earliest timer due by `end` (the oldest on a tie), or -1.
   */
  private dueIndex(end: number): number {
    let best = -1;
    for (let i = 0; i < this.pending.length; i += 1) {
      const entry = this.pending[i];
      if (entry.at > end + DUE_EPSILON) continue;
      if (best < 0) {
        best = i;
        continue;
      }
      const top = this.pending[best];
      if (entry.at < top.at || (entry.at === top.at && entry.id < top.id)) best = i;
    }
    return best;
  }

  /** @param index A pending entry to drop and pool (swap-removed: order lives in `at` and `id`). */
  private release(index: number): void {
    const entry = this.pending[index];
    const last = this.pending.pop() as TimerEntry;
    if (last !== entry) this.pending[index] = last;
    entry.fn = null;
    this.free.push(entry);
  }
}
