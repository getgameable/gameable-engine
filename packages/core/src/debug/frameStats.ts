/**
 * Frame-time statistics over a fixed window.
 *
 * A ring buffer of the last N frame durations plus an exponential moving
 * average of the frame rate. Percentiles sort a preallocated scratch copy in
 * place, so reading them allocates nothing either — which matters, because the
 * debug overlay reads them while the thing it is measuring is running.
 */

/** Frames kept in the window by default: two seconds at 60 Hz. */
export const DEFAULT_SAMPLE_COUNT = 120;

/** Weight of the newest sample in the frame-rate EMA. */
const FPS_SMOOTHING = 0.1;

/** A rolling window of frame durations. */
export interface FrameStats {
  /** Frames the window holds. */
  readonly capacity: number;
  /** Samples recorded so far, capped at `capacity`. */
  readonly count: number;
  /** Smoothed frames per second. */
  readonly fps: number;
  /** Duration of the most recent frame, in milliseconds. */
  readonly last: number;

  /**
   * Record one frame.
   *
   * @param frameMs How long the frame took, in milliseconds.
   */
  push(frameMs: number): void;

  /**
   * A percentile of the window.
   *
   * @param p Percentile in `[0, 1]`; `0.5` is the median.
   * @returns The frame time in milliseconds, or `0` before any sample.
   */
  percentile(p: number): number;

  /**
   * Forget every sample.
   */
  reset(): void;
}

/**
 * Build a frame-time window.
 *
 * @param capacity Frames to keep. Defaults to `120`.
 * @returns An empty window.
 *
 * @example
 * ```ts
 * import { createFrameStats } from 'gameable/core';
 *
 * const stats = createFrameStats(4);
 * for (const ms of [10, 20, 30, 40]) stats.push(ms);
 * console.log(stats.percentile(0.5)); // 20
 * ```
 */
export function createFrameStats(capacity: number = DEFAULT_SAMPLE_COUNT): FrameStats {
  const size = Math.max(1, Math.floor(capacity));
  const samples = new Float64Array(size);
  const scratch = new Float64Array(size);

  let write = 0;
  let count = 0;
  let fps = 0;
  let last = 0;

  return {
    capacity: size,
    get count() {
      return count;
    },
    get fps() {
      return fps;
    },
    get last() {
      return last;
    },

    push(frameMs) {
      last = frameMs;
      samples[write] = frameMs;
      write = (write + 1) % size;
      if (count < size) count += 1;

      if (frameMs > 0) {
        const instant = 1000 / frameMs;
        fps = count === 1 ? instant : fps + (instant - fps) * FPS_SMOOTHING;
      }
    },

    percentile(p) {
      if (count === 0) return 0;
      // `subarray` is a view, not a copy, so this allocates nothing.
      const view = scratch.subarray(0, count);
      view.set(samples.subarray(0, count));
      view.sort();
      const clamped = p < 0 ? 0 : p > 1 ? 1 : p;
      const index = Math.min(count - 1, Math.max(0, Math.round(clamped * (count - 1))));
      return view[index] ?? 0;
    },

    reset() {
      samples.fill(0);
      write = 0;
      count = 0;
      fps = 0;
      last = 0;
    },
  };
}
