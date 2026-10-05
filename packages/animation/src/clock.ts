/**
 * clock — the single time source for every module in this package.
 *
 * The POC mixed `performance.now()` (blink, gestures, face clips) with
 * `Date.now()` (the direct-play hold in `bodyMotionClip.js`). The two drift
 * apart — `Date.now()` jumps when the system clock is adjusted and has ~1 ms
 * granularity — so an envelope started against one and expired against the
 * other could release early or wedge. Every runtime here takes an injected
 * `now()` instead, which also makes the envelopes deterministic in tests.
 */

/**
 * A monotonic clock reading, in **milliseconds**.
 *
 * Implementations must be monotonic and must not be mixed within one runtime:
 * an envelope started against one clock is always expired against the same one.
 */
export type Clock = () => number;

/**
 * The default clock: `performance.now()`, monotonic and sub-millisecond.
 *
 * @returns Milliseconds since the time origin.
 */
export const defaultClock: Clock = () => performance.now();
