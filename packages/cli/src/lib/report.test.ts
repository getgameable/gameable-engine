import { describe, expect, it } from 'vitest';

import {
  DEFAULT_GATES,
  brotliSize,
  checkGates,
  formatBytes,
  formatReport,
  percentile,
  type ReportNumbers,
} from './report.js';

/**
 * A plausible measurement, so each test can change one field.
 *
 * @param overrides Fields to replace.
 * @returns A complete set of numbers.
 */
function numbers(overrides: Partial<ReportNumbers> = {}): ReportNumbers {
  return {
    wasmBytes: 2_173_240,
    wasmBrotli: 593_457,
    guestBytes: 2_655_773,
    guestBrotli: 620_000,
    coldInstantiateMs: 420,
    warmInstantiateMs: 12,
    ticks: 1000,
    tickP50: 0.09,
    tickP99: 0.42,
    ...overrides,
  };
}

describe('percentile', () => {
  it('returns 0 for an empty sample', () => {
    expect(percentile([], 0.99)).toBe(0);
  });

  it('finds the median of a shuffled sample', () => {
    expect(percentile([5, 1, 3, 2, 4], 0.5)).toBe(3);
  });

  it('finds the p99 of a hundred samples', () => {
    const samples = Array.from({ length: 100 }, (_, i) => i);
    expect(percentile(samples, 0.99)).toBe(99);
  });

  it('never reads past the end', () => {
    expect(percentile([7], 1)).toBe(7);
  });
});

describe('checkGates', () => {
  it('passes a build inside both budgets', () => {
    expect(checkGates(numbers(), DEFAULT_GATES)).toEqual([]);
  });

  it('fails a slow tick', () => {
    const failures = checkGates(numbers({ tickP99: 1.6 }), DEFAULT_GATES);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain('tick p99');
  });

  it('passes a tick exactly on the budget', () => {
    expect(checkGates(numbers({ tickP99: 1.5 }), DEFAULT_GATES)).toEqual([]);
  });

  it('fails an oversized component', () => {
    const failures = checkGates(numbers({ wasmBrotli: 900_000 }), DEFAULT_GATES);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain('brotli');
  });

  it('reports both failures at once', () => {
    expect(checkGates(numbers({ tickP99: 9, wasmBrotli: 9_000_000 }), DEFAULT_GATES)).toHaveLength(
      2,
    );
  });

  it('uses the documented thresholds', () => {
    expect(DEFAULT_GATES.maxTickP99Ms).toBe(1.5);
    expect(DEFAULT_GATES.maxWasmBrotliBytes).toBe(838_861);
  });
});

describe('formatBytes', () => {
  it('scales to KiB and MiB', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2048)).toBe('2.0 KiB');
    expect(formatBytes(2 * 1024 * 1024)).toBe('2.00 MiB');
  });
});

describe('formatReport', () => {
  it('prints every measured number with its budget', () => {
    const text = formatReport(numbers(), DEFAULT_GATES);
    expect(text).toContain('component brotli');
    expect(text).toContain('dist/guest');
    expect(text).toContain('instantiate cold');
    expect(text).toContain('tick p99');
    expect(text).toContain('budget');
  });
});

describe('brotliSize', () => {
  it('compresses repetitive bytes hard', () => {
    const bytes = new Uint8Array(64 * 1024).fill(7);
    expect(brotliSize(bytes)).toBeLessThan(1024);
  });
});
