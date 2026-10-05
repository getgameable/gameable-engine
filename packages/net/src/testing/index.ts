/**
 * `gameable/net/testing` — in-memory transports for tests.
 *
 * @example
 * ```ts
 * import { latencyPair, loopbackPair } from 'gameable/net/testing';
 * const [a, b] = loopbackPair();
 * const [slowA, slowB] = latencyPair({ ms: 80, loss: 0.05, seed: 3 });
 * ```
 */
export { latencyPair, loopbackPair, type LatencyOptions } from '../transport/index.js';
