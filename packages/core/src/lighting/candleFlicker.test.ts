import { expect, it } from 'vitest';
import { candleFlicker } from './candleFlicker';
it('has bounded, smooth, deterministic candle variation with independent phases', () => {
  let minimum = Infinity,
    maximum = -Infinity;
  for (let i = 0; i < 3600; i++) {
    const t = i / 60,
      value = candleFlicker(t, 3);
    expect(value).toBe(candleFlicker(t, 3));
    expect(value).toBeGreaterThanOrEqual(0.58);
    expect(value).toBeLessThanOrEqual(1.2);
    expect(Math.abs(value - candleFlicker(t + 0.001, 3))).toBeLessThan(0.005);
    minimum = Math.min(minimum, value);
    maximum = Math.max(maximum, value);
  }
  expect(maximum - minimum).toBeGreaterThan(0.2);
  expect(candleFlicker(1, 0)).not.toBe(candleFlicker(1, 1));
});
