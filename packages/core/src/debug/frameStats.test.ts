import { describe, expect, it } from 'vitest';

import { createFrameStats, DEFAULT_SAMPLE_COUNT } from './frameStats.js';

describe('createFrameStats', () => {
  it('keeps 120 frames by default', () => {
    expect(createFrameStats().capacity).toBe(DEFAULT_SAMPLE_COUNT);
  });

  it('reads as empty before the first sample', () => {
    const stats = createFrameStats(8);
    expect(stats.count).toBe(0);
    expect(stats.fps).toBe(0);
    expect(stats.last).toBe(0);
    expect(stats.percentile(0.5)).toBe(0);
  });

  it('counts samples up to the capacity and no further', () => {
    const stats = createFrameStats(4);
    for (let i = 0; i < 10; i += 1) stats.push(16);
    expect(stats.count).toBe(4);
    expect(stats.last).toBe(16);
  });

  it('computes percentiles over the window', () => {
    const stats = createFrameStats(5);
    for (const ms of [50, 10, 30, 20, 40]) stats.push(ms);

    expect(stats.percentile(0)).toBe(10);
    expect(stats.percentile(0.5)).toBe(30);
    expect(stats.percentile(1)).toBe(50);
  });

  it('clamps the percentile argument', () => {
    const stats = createFrameStats(4);
    for (const ms of [1, 2, 3, 4]) stats.push(ms);
    expect(stats.percentile(-1)).toBe(1);
    expect(stats.percentile(2)).toBe(4);
  });

  it('percentiles ignore samples that have rolled out of the window', () => {
    const stats = createFrameStats(3);
    stats.push(1000);
    stats.push(10);
    stats.push(10);
    stats.push(10); // pushes the 1000 out

    expect(stats.percentile(1)).toBe(10);
  });

  it('does not mutate the window when reading a percentile', () => {
    const stats = createFrameStats(4);
    for (const ms of [40, 10, 30, 20]) stats.push(ms);
    stats.percentile(0.95);
    expect(stats.last).toBe(20);
    expect(stats.percentile(0)).toBe(10);
  });

  it('reports the exact frame rate from the first sample', () => {
    const stats = createFrameStats(8);
    stats.push(1000 / 60);
    expect(stats.fps).toBeCloseTo(60, 6);
  });

  it('smooths the frame rate towards a new steady state', () => {
    const stats = createFrameStats(200);
    stats.push(1000 / 60);
    for (let i = 0; i < 100; i += 1) stats.push(1000 / 30);

    // The EMA has converged on 30, having started at 60.
    expect(stats.fps).toBeGreaterThan(29.9);
    expect(stats.fps).toBeLessThan(30.1);
  });

  it('does not let a zero-length frame produce an infinite frame rate', () => {
    const stats = createFrameStats(8);
    stats.push(0);
    expect(stats.fps).toBe(0);
    expect(Number.isFinite(stats.fps)).toBe(true);
  });

  it('resets to empty', () => {
    const stats = createFrameStats(4);
    for (const ms of [1, 2, 3]) stats.push(ms);
    stats.reset();
    expect(stats.count).toBe(0);
    expect(stats.fps).toBe(0);
    expect(stats.percentile(0.5)).toBe(0);
  });
});
