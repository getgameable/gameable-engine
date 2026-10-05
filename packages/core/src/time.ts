/**
 * The engine clock.
 *
 * One object, updated in place once per frame. Nothing here allocates, and
 * everything a module needs to know about "when" is on it.
 */

/** Read-only view of the engine clock, as modules and game code see it. */
export interface Time {
  /** `performance.now()` of the current frame, in milliseconds. */
  readonly now: number;
  /** Scaled seconds simulated since `start()`. */
  readonly elapsed: number;
  /** Length of one fixed step, in seconds. */
  readonly fixedDt: number;
  /**
   * Frames rendered since `start()`, starting at 0.
   *
   * Rendered frames, not fixed steps: on a 144 Hz display this runs ahead of
   * the simulation's own step counter, which the guest sees as its `frame`.
   */
  readonly renderFrame: number;
  /**
   * Simulation speed multiplier. `0` pauses, `0.5` is half speed.
   *
   * Changes how many fixed steps a frame buys, never how long a step is: a
   * fixed step is always `fixedDt`.
   */
  timeScale: number;
}

/** The engine's own handle on the clock: the same object, writable. */
export interface MutableTime extends Time {
  /** @inheritDoc */
  now: number;
  /** @inheritDoc */
  elapsed: number;
  /** @inheritDoc */
  fixedDt: number;
  /** @inheritDoc */
  renderFrame: number;
}

/**
 * Build an engine clock.
 *
 * @param fixedDt Length of one fixed step, in seconds.
 * @returns A clock at render frame 0, elapsed 0, `timeScale` 1.
 *
 * @example
 * ```ts
 * import { createTime } from 'gameable/core';
 *
 * const time = createTime(1 / 60);
 * time.timeScale = 0.5; // slow motion
 * console.log(time.fixedDt); // 0.016666…
 * ```
 */
export function createTime(fixedDt: number): MutableTime {
  return { now: 0, elapsed: 0, fixedDt, renderFrame: 0, timeScale: 1 };
}
