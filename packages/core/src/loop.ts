/**
 * The fixed-step accumulator, with no `requestAnimationFrame` in sight.
 *
 * `createFixedLoop` is pure: you hand it a timestamp, it decides how many fixed
 * steps that timestamp buys and calls back. `createEngine` drives it from rAF;
 * tests drive it from an array of numbers.
 *
 * Nothing here allocates once the loop exists: `step` writes into one reused
 * {@link FrameTiming} record.
 */

/** Default simulation rate: 60 Hz. */
export const DEFAULT_FIXED_DT = 1 / 60;

/** Default cap on fixed steps per frame. */
export const DEFAULT_MAX_SUBSTEPS = 5;

/**
 * Slack in the accumulator comparison, in seconds.
 *
 * A 60 Hz display driving a 60 Hz simulation lands within a rounding error of a
 * whole step every frame. Without this microsecond of slack the comparison
 * flips on float noise and the loop alternates between zero and two substeps —
 * visible judder, from arithmetic alone.
 */
const STEP_EPSILON = 1e-6;

/**
 * What a call to {@link FixedLoop.step} did.
 *
 * The loop hands back the same record every frame. Read it before the next
 * `step`; never retain it.
 */
export interface FrameTiming {
  /** Wall-clock seconds since the previous frame, after clamping. */
  readonly dtReal: number;
  /** Wall-clock seconds since the previous frame, before clamping. */
  readonly rawDt: number;
  /** Fixed steps run this frame, `0` to `maxSubsteps`. */
  readonly substeps: number;
  /** Interpolation factor for rendering, always in `[0, 1)`. */
  readonly alpha: number;
  /** True when time had to be thrown away to avoid a death spiral. */
  readonly clamped: boolean;
}

/** The loop's own writable view of its timing record. */
interface MutableFrameTiming {
  dtReal: number;
  rawDt: number;
  substeps: number;
  alpha: number;
  clamped: boolean;
}

/** Options accepted by {@link createFixedLoop}. */
export interface FixedLoopOptions {
  /** Length of one fixed step, in seconds. Defaults to `1/60`. */
  readonly fixedDt?: number;
  /** Most fixed steps one frame may run. Defaults to `5`. */
  readonly maxSubsteps?: number;
  /**
   * Run once per fixed step, always with exactly `fixedDt`.
   *
   * @param dt Always `fixedDt`, whatever `timeScale` is.
   */
  readonly fixedUpdate?: (dt: number) => void;
  /**
   * Run once per frame, after the fixed steps.
   *
   * @param dtReal Clamped wall-clock seconds since the previous frame. Not
   *   scaled by `timeScale`; presentation code decides for itself.
   * @param alpha Interpolation factor in `[0, 1)`.
   */
  readonly update?: (dtReal: number, alpha: number) => void;
  /**
   * Run once per frame, last.
   *
   * @param alpha Interpolation factor in `[0, 1)`.
   */
  readonly render?: (alpha: number) => void;
}

/** A driven fixed-step accumulator. */
export interface FixedLoop {
  /** Length of one fixed step, in seconds. */
  readonly fixedDt: number;
  /** Most fixed steps one frame may run. */
  readonly maxSubsteps: number;
  /** Unconsumed simulation time, always in `[0, fixedDt)` after a step. */
  readonly accumulator: number;
  /** Interpolation factor for the last frame, in `[0, 1)`. */
  readonly alpha: number;
  /** Frames stepped so far. */
  readonly frame: number;
  /**
   * Simulation speed multiplier. `1` is real time, `0.5` is half speed, `0`
   * pauses the simulation while frames keep rendering.
   *
   * Scales how much simulation time a frame *buys*, not the step length: a
   * fixed step is always `fixedDt` long, so physics and the game see the same
   * `dt` at every speed and a recording replays at any speed. Negative values
   * are treated as `0`.
   */
  timeScale: number;

  /**
   * Advance the loop to `nowMs`.
   *
   * The very first call only establishes the baseline: `dtReal` is 0 and no
   * fixed step runs, so a slow boot cannot manufacture a burst of simulation.
   *
   * @param nowMs A monotonic timestamp in milliseconds, usually from rAF.
   * @returns What this frame did. The same record every call; do not retain it.
   */
  step(nowMs: number): FrameTiming;

  /**
   * Forget the accumulator and the baseline timestamp.
   *
   * Call after a long pause (tab hidden, breakpoint, level load) so the next
   * `step` starts clean instead of clamping.
   */
  reset(): void;
}

/**
 * Build a fixed-step loop.
 *
 * The accumulator drains at most `maxSubsteps` times per frame. Anything left
 * over is thrown away rather than carried, because carrying it is what turns a
 * slow frame into a spiral of death: each frame owes more simulation than the
 * last and the game never catches up. `clamped` in the returned
 * {@link FrameTiming} says when that happened.
 *
 * @param options Step length, substep cap and the three callbacks.
 * @returns The loop. Nothing runs until you call `step`.
 *
 * @example
 * ```ts
 * import { createFixedLoop } from 'gameable/core';
 *
 * let ticks = 0;
 * const loop = createFixedLoop({ fixedUpdate: () => { ticks += 1; } });
 * loop.step(0);      // baseline: no fixed steps
 * loop.step(1000/30); // 33.3 ms buys two 60 Hz steps
 * console.log(ticks); // 2
 * ```
 */
export function createFixedLoop(options: FixedLoopOptions = {}): FixedLoop {
  const fixedDt = options.fixedDt ?? DEFAULT_FIXED_DT;
  const maxSubsteps = options.maxSubsteps ?? DEFAULT_MAX_SUBSTEPS;

  if (!(fixedDt > 0)) throw new RangeError('createFixedLoop: fixedDt must be greater than 0');
  if (!Number.isInteger(maxSubsteps) || maxSubsteps < 1) {
    throw new RangeError('createFixedLoop: maxSubsteps must be an integer >= 1');
  }

  const { fixedUpdate, update, render } = options;
  /** Longest wall-clock frame the accumulator will accept, in seconds. */
  const maxFrameSeconds = fixedDt * maxSubsteps;

  let lastMs: number | null = null;
  let accumulator = 0;
  let alpha = 0;
  let frame = 0;

  const timing: MutableFrameTiming = {
    dtReal: 0,
    rawDt: 0,
    substeps: 0,
    alpha: 0,
    clamped: false,
  };

  const loop: FixedLoop = {
    fixedDt,
    maxSubsteps,
    timeScale: 1,
    get accumulator() {
      return accumulator;
    },
    get alpha() {
      return alpha;
    },
    get frame() {
      return frame;
    },

    step(nowMs: number): FrameTiming {
      let rawDt = 0;
      if (lastMs !== null) rawDt = (nowMs - lastMs) / 1000;
      lastMs = nowMs;

      // A clock that ran backwards (manual seek, bad timestamp) is not a frame.
      if (rawDt < 0) rawDt = 0;

      let dtReal = rawDt;
      let clamped = false;
      if (dtReal > maxFrameSeconds) {
        dtReal = maxFrameSeconds;
        clamped = true;
      }

      // Time scale buys more or fewer whole steps; it never changes their length.
      const scale = loop.timeScale > 0 ? loop.timeScale : 0;
      accumulator += dtReal * scale;

      let substeps = 0;
      while (accumulator >= fixedDt - STEP_EPSILON && substeps < maxSubsteps) {
        fixedUpdate?.(fixedDt);
        accumulator -= fixedDt;
        substeps += 1;
      }
      if (accumulator < 0) accumulator = 0;

      // Floating-point leftovers can still leave a whole step in the bank.
      // Drop it rather than owe it.
      if (accumulator >= fixedDt) {
        accumulator %= fixedDt;
        clamped = true;
      }

      alpha = accumulator / fixedDt;
      frame += 1;

      update?.(dtReal, alpha);
      render?.(alpha);

      timing.dtReal = dtReal;
      timing.rawDt = rawDt;
      timing.substeps = substeps;
      timing.alpha = alpha;
      timing.clamped = clamped;
      return timing;
    },

    reset() {
      lastMs = null;
      accumulator = 0;
      alpha = 0;
    },
  };

  return loop;
}
