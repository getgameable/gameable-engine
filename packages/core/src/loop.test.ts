import { describe, expect, it, vi } from 'vitest';

import { createFixedLoop, DEFAULT_FIXED_DT, DEFAULT_MAX_SUBSTEPS } from './loop.js';

/**
 * Milliseconds per frame at a given refresh rate.
 *
 * @param hz Frames per second.
 * @returns The frame period in milliseconds.
 */
const ms = (hz: number) => 1000 / hz;

describe('createFixedLoop', () => {
  it('uses 60 Hz and 5 substeps by default', () => {
    const loop = createFixedLoop();
    expect(loop.fixedDt).toBeCloseTo(DEFAULT_FIXED_DT, 12);
    expect(loop.maxSubsteps).toBe(DEFAULT_MAX_SUBSTEPS);
  });

  it.each([
    [0, 'fixedDt must be greater than 0', { fixedDt: 0 }],
    [1, 'fixedDt must be greater than 0', { fixedDt: -1 }],
    [2, 'maxSubsteps must be an integer', { maxSubsteps: 0 }],
    [3, 'maxSubsteps must be an integer', { maxSubsteps: 2.5 }],
  ])('rejects bad option set %i', (_i, message, options) => {
    expect(() => createFixedLoop(options)).toThrow(message);
  });

  it('runs no fixed step on the very first frame', () => {
    const fixedUpdate = vi.fn();
    const update = vi.fn();
    const render = vi.fn();
    const loop = createFixedLoop({ fixedUpdate, update, render });

    const timing = loop.step(12345);

    expect(timing.substeps).toBe(0);
    expect(timing.dtReal).toBe(0);
    expect(fixedUpdate).not.toHaveBeenCalled();
    expect(update).toHaveBeenCalledWith(0, 0);
    expect(render).toHaveBeenCalledWith(0);
  });

  it('runs exactly one substep per frame at 60 Hz', () => {
    const fixedUpdate = vi.fn();
    const loop = createFixedLoop({ fixedUpdate });
    loop.step(0);

    const counts: number[] = [];
    for (let i = 1; i <= 10; i += 1) counts.push(loop.step(i * ms(60)).substeps);

    expect(counts).toEqual([1, 1, 1, 1, 1, 1, 1, 1, 1, 1]);
    expect(fixedUpdate).toHaveBeenCalledTimes(10);
    expect(fixedUpdate).toHaveBeenLastCalledWith(loop.fixedDt);
  });

  it('alternates 0 and 1 substeps at 120 Hz and averages one per two frames', () => {
    const loop = createFixedLoop();
    loop.step(0);

    let total = 0;
    const counts: number[] = [];
    for (let i = 1; i <= 20; i += 1) {
      const n = loop.step(i * ms(120)).substeps;
      counts.push(n);
      total += n;
    }

    expect(new Set(counts)).toEqual(new Set([0, 1]));
    expect(total).toBe(10);
  });

  it('runs two substeps per frame at roughly 30 Hz', () => {
    const loop = createFixedLoop();
    loop.step(0);
    const counts: number[] = [];
    for (let i = 1; i <= 5; i += 1) counts.push(loop.step(i * 34).substeps);
    expect(counts).toEqual([2, 2, 2, 2, 2]);
  });

  it.each([
    [17, 1],
    [34, 2],
    [51, 3],
    [83, 4],
  ])('a %d ms frame buys %d substeps', (frameMs, expected) => {
    const loop = createFixedLoop();
    loop.step(0);
    expect(loop.step(frameMs).substeps).toBe(expected);
  });

  it('clamps a one-second stall to maxSubsteps and throws the rest away', () => {
    const loop = createFixedLoop({ maxSubsteps: 5 });
    loop.step(0);

    const timing = loop.step(1000);

    expect(timing.substeps).toBe(5);
    expect(timing.clamped).toBe(true);
    expect(timing.rawDt).toBeCloseTo(1, 6);
    expect(timing.dtReal).toBeCloseTo(5 / 60, 6);
    expect(loop.accumulator).toBeLessThan(loop.fixedDt);
  });

  it('does not spiral: a run of stalls never owes more than one frame', () => {
    const loop = createFixedLoop();
    loop.step(0);
    let now = 0;
    for (let i = 0; i < 20; i += 1) {
      now += 500;
      const timing = loop.step(now);
      expect(timing.substeps).toBeLessThanOrEqual(loop.maxSubsteps);
      expect(loop.accumulator).toBeLessThan(loop.fixedDt);
    }
  });

  it('keeps alpha in [0, 1) across an irregular frame sequence', () => {
    const loop = createFixedLoop();
    loop.step(0);
    let now = 0;
    for (const frameMs of [16.7, 3, 41, 8.2, 200, 0, 16.7, 33.4, 1.1, 999]) {
      now += frameMs;
      const timing = loop.step(now);
      expect(timing.alpha).toBeGreaterThanOrEqual(0);
      expect(timing.alpha).toBeLessThan(1);
      expect(timing.alpha).toBe(loop.alpha);
    }
  });

  it('reports alpha as the fraction of a step left over', () => {
    const loop = createFixedLoop();
    loop.step(0);
    // Half a step: no substep, alpha 0.5.
    expect(loop.step(ms(120)).alpha).toBeCloseTo(0.5, 6);
    // Another full step on top: one substep fires and the same half remains.
    const timing = loop.step(ms(120) + ms(60));
    expect(timing.substeps).toBe(1);
    expect(timing.alpha).toBeCloseTo(0.5, 6);
  });

  it('treats a backwards clock as a zero-length frame', () => {
    const fixedUpdate = vi.fn();
    const loop = createFixedLoop({ fixedUpdate });
    loop.step(1000);
    const timing = loop.step(500);
    expect(timing.rawDt).toBe(0);
    expect(timing.substeps).toBe(0);
    expect(fixedUpdate).not.toHaveBeenCalled();
  });

  it('honours a custom fixedDt and maxSubsteps', () => {
    const fixedUpdate = vi.fn();
    const loop = createFixedLoop({ fixedDt: 1 / 120, maxSubsteps: 2, fixedUpdate });
    loop.step(0);
    const timing = loop.step(100);
    expect(timing.substeps).toBe(2);
    expect(timing.clamped).toBe(true);
    expect(fixedUpdate).toHaveBeenCalledWith(1 / 120);
  });

  it('calls fixedUpdate, then update, then render, in that order', () => {
    const calls: string[] = [];
    const loop = createFixedLoop({
      fixedUpdate: () => calls.push('fixed'),
      update: () => calls.push('update'),
      render: () => calls.push('render'),
    });
    loop.step(0);
    calls.length = 0;
    loop.step(ms(30));
    expect(calls).toEqual(['fixed', 'fixed', 'update', 'render']);
  });

  it('counts frames and resets cleanly', () => {
    const fixedUpdate = vi.fn();
    const loop = createFixedLoop({ fixedUpdate });
    loop.step(0);
    loop.step(ms(120)); // leaves half a step banked
    expect(loop.frame).toBe(2);
    expect(loop.accumulator).toBeGreaterThan(0);

    loop.reset();
    expect(loop.accumulator).toBe(0);
    expect(loop.alpha).toBe(0);

    // After a reset the next step is a baseline again.
    expect(loop.step(9_999_999).substeps).toBe(0);
    expect(fixedUpdate).not.toHaveBeenCalled();
  });

  it('returns the same timing record every frame, with fresh fields', () => {
    const loop = createFixedLoop();
    const first = loop.step(0);
    const second = loop.step(ms(60));
    expect(second).toBe(first);
    expect(second.substeps).toBe(1);
    expect(second.dtReal).toBeCloseTo(1 / 60, 9);
  });

  it('scales the accumulator with timeScale, never the step length', () => {
    const fixedUpdate = vi.fn();
    const loop = createFixedLoop({ fixedUpdate });
    loop.timeScale = 0.5;
    loop.step(0);
    for (let i = 1; i <= 20; i += 1) loop.step(i * ms(60));

    expect(fixedUpdate).toHaveBeenCalledTimes(10);
    for (const call of fixedUpdate.mock.calls) expect(call[0]).toBe(loop.fixedDt);
  });

  it('freezes the simulation at timeScale 0 but keeps rendering', () => {
    const fixedUpdate = vi.fn();
    const update = vi.fn();
    const render = vi.fn();
    const loop = createFixedLoop({ fixedUpdate, update, render });
    loop.timeScale = 0;
    loop.step(0);
    for (let i = 1; i <= 5; i += 1) loop.step(i * ms(60));

    expect(fixedUpdate).not.toHaveBeenCalled();
    expect(update).toHaveBeenCalledTimes(6);
    expect(render).toHaveBeenCalledTimes(6);
    expect(update).toHaveBeenLastCalledWith(expect.closeTo(1 / 60, 9), 0);
  });

  it('treats a negative timeScale as a pause', () => {
    const fixedUpdate = vi.fn();
    const loop = createFixedLoop({ fixedUpdate });
    loop.timeScale = -3;
    loop.step(0);
    loop.step(ms(60));
    expect(fixedUpdate).not.toHaveBeenCalled();
    expect(loop.accumulator).toBe(0);
  });

  it('computes alpha from the scaled accumulator', () => {
    const loop = createFixedLoop();
    loop.timeScale = 0.5;
    loop.step(0);
    const timing = loop.step(ms(60));
    expect(timing.substeps).toBe(0);
    expect(timing.alpha).toBeCloseTo(0.5, 6);
  });

  it('works with no callbacks at all', () => {
    const loop = createFixedLoop();
    loop.step(0);
    expect(() => loop.step(ms(30))).not.toThrow();
  });
});
