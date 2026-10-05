/**
 * Stable noise at a time sample; no random state or per-frame allocation.
 *
 * @param step
 * @param lamp
 */
function sample(step: number, lamp: number): number {
  let bits = Math.imul(step, 374761393) ^ Math.imul(lamp + 1, 668265263);
  bits = Math.imul(bits ^ (bits >>> 13), 1274126177);
  return ((bits ^ (bits >>> 16)) >>> 0) / 4294967295;
}

/**
 * Smooth interpolation keeps irregular flame flutter continuous across sample boundaries.
 *
 * @param time
 * @param lamp
 */
function noise(time: number, lamp: number): number {
  const step = Math.floor(time);
  const fraction = time - step;
  const blend = fraction * fraction * (3 - 2 * fraction);
  const start = sample(step, lamp);
  return start + (sample(step + 1, lamp) - start) * blend;
}

/**
 * Deterministic, continuous candle gain in [0.58, 1.2], with a steady core and shallow draught dips.
 *
 * @param seconds Elapsed scene time in seconds.
 * @param index Stable fixture seed; different fixtures flicker independently.
 * @returns Intensity multiplier; no random state or frame allocation.
 * @example
 * ```ts
 * light.intensity = 2.6 * candleFlicker(elapsed, 3);
 * ```
 */
export function candleFlicker(seconds: number, index: number): number {
  const drift = 0.12 * (2 * noise(seconds * 1.6, index) - 1);
  const flutter = 0.08 * (2 * noise(seconds * 7, index + 31) - 1);
  // Only the upper tail of slow noise bends the flame; each fixture has its own draught.
  const draught = Math.max(0, (noise(seconds * 0.85, index + 79) - 0.72) / 0.28);
  return 1 + drift + flutter - 0.22 * draught * draught;
}
