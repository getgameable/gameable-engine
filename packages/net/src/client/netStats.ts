/**
 * The `net` service's counters, all at zero: one place, so every service
 * (the real one and the tests' scripted one) starts from the same fields.
 */
import type { NetStats } from './NetService.js';

/**
 * @returns Fresh counters, every one 0.
 *
 * @example
 * ```ts
 * import { emptyNetStats } from './netStats.js';
 *
 * const stats = emptyNetStats();
 * stats.corrections; // 0
 * ```
 */
export function emptyNetStats(): NetStats {
  return {
    staleRows: 0,
    rowsFrames: 0,
    commandFrames: 0,
    messages: 0,
    badFrames: 0,
    inputsSent: 0,
    resyncs: 0,
    silences: 0,
    warnings: 0,
    corrections: 0,
  };
}
