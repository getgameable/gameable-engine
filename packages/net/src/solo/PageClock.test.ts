import { describe, expect, it } from 'vitest';

import { PageClock } from './PageClock.js';

const STEP = 1000 / 60;

describe('PageClock', () => {
  it('fires timers as their time comes, each at its own due time', () => {
    const clock = new PageClock();
    const fired: string[] = [];
    clock.setTimer(() => fired.push(`a@${String(clock.now())}`), 10);
    clock.setTimer(() => fired.push(`b@${String(clock.now())}`), 5);
    clock.advanceTo(7);
    expect(fired).toEqual(['b@5']);
    expect(clock.now()).toBe(7);
    clock.advanceTo(12);
    expect(fired).toEqual(['b@5', 'a@10']);
  });

  it('runs a timer set by a firing timer in the same advance when it is already due', () => {
    const clock = new PageClock();
    let ticks = 0;
    const tick = (): void => {
      ticks += 1;
      clock.setTimer(tick, 10);
    };
    clock.setTimer(tick, 10);
    clock.advanceTo(45);
    expect(ticks).toBe(4);
    expect(clock.now()).toBe(45);
  });

  it('fires a 60 Hz timer chain exactly once per step when moved by k x step (no float drift)', () => {
    const clock = new PageClock();
    let ticks = 0;
    const tick = (): void => {
      ticks += 1;
      clock.setTimer(tick, STEP);
    };
    clock.setTimer(tick, STEP);
    for (let k = 1; k <= 3600; k += 1) {
      clock.advanceTo(k * STEP);
      expect(ticks).toBe(k);
    }
  });

  it('fires timers due at the same time in the order they were set', () => {
    const clock = new PageClock();
    const fired: number[] = [];
    for (let i = 0; i < 4; i += 1) clock.setTimer(() => fired.push(i), 5);
    clock.advanceTo(5);
    expect(fired).toEqual([0, 1, 2, 3]);
  });

  it('cancels a pending timer, and a time in the past moves nothing', () => {
    const clock = new PageClock();
    const fired: string[] = [];
    const handle = clock.setTimer(() => fired.push('gone'), 5);
    clock.setTimer(() => fired.push('kept'), 5);
    clock.clearTimer(handle);
    clock.advanceTo(3);
    clock.advanceTo(1);
    expect(clock.now()).toBe(3);
    clock.advanceTo(6);
    expect(fired).toEqual(['kept']);
  });
});
