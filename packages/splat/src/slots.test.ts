import { describe, expect, it } from 'vitest';

import { createSlotAllocator, SlotAllocationError } from './slots.js';

describe('createSlotAllocator', () => {
  it('starts as one free run covering the capacity', () => {
    const slots = createSlotAllocator(100);
    expect(slots.capacity).toBe(100);
    expect(slots.used).toBe(0);
    expect(slots.available).toBe(100);
    expect(slots.freeRuns).toEqual([{ offset: 0, count: 100 }]);
  });

  it('rejects a capacity that is not a positive integer', () => {
    expect(() => createSlotAllocator(0)).toThrow(RangeError);
    expect(() => createSlotAllocator(-1)).toThrow(RangeError);
    expect(() => createSlotAllocator(1.5)).toThrow(RangeError);
  });

  it('allocates contiguously from the front', () => {
    const slots = createSlotAllocator(100);
    expect(slots.allocate(30)).toEqual({ offset: 0, count: 30 });
    expect(slots.allocate(20)).toEqual({ offset: 30, count: 20 });
    expect(slots.allocate(50)).toEqual({ offset: 50, count: 50 });
    expect(slots.available).toBe(0);
    expect(slots.freeRuns).toEqual([]);
  });

  it('rejects a count that is not a positive integer', () => {
    const slots = createSlotAllocator(10);
    expect(() => slots.allocate(0)).toThrow(RangeError);
    expect(() => slots.allocate(2.5)).toThrow(RangeError);
  });

  it('throws a SlotAllocationError naming the largest free run', () => {
    const slots = createSlotAllocator(100);
    slots.allocate(80);
    let error: unknown;
    try {
      slots.allocate(21);
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(SlotAllocationError);
    expect((error as SlotAllocationError).requested).toBe(21);
    expect((error as SlotAllocationError).largestFree).toBe(20);
  });

  describe('first fit', () => {
    it('takes the first run that is big enough, not the tightest', () => {
      const slots = createSlotAllocator(100);
      const a = slots.allocate(10); // [0, 10)
      const b = slots.allocate(10); // [10, 20)
      slots.allocate(10); //           [20, 30) stays held
      slots.allocate(10); //           [30, 40) stays held
      slots.free(b); // a 10-wide hole at 10
      slots.free(a); // merges into a 20-wide hole at 0

      // A tight fit exists at 10..20 only after the merge; first-fit must take offset 0.
      expect(slots.allocate(5)).toEqual({ offset: 0, count: 5 });
    });

    it('skips runs that are too small', () => {
      const slots = createSlotAllocator(50);
      const a = slots.allocate(5);
      slots.allocate(5);
      const c = slots.allocate(20);
      slots.free(a); // 5-wide hole at 0
      slots.free(c); // 20-wide hole at 10

      expect(slots.allocate(20)).toEqual({ offset: 10, count: 20 });
      expect(slots.freeRuns).toEqual([
        { offset: 0, count: 5 },
        { offset: 30, count: 20 },
      ]);
    });
  });

  describe('coalescing frees', () => {
    it('merges with the run after it', () => {
      const slots = createSlotAllocator(30);
      const a = slots.allocate(10);
      const b = slots.allocate(10);
      slots.free(b);
      slots.free(a);
      expect(slots.freeRuns).toEqual([{ offset: 0, count: 30 }]);
    });

    it('merges with the run before it', () => {
      const slots = createSlotAllocator(30);
      const a = slots.allocate(10);
      const b = slots.allocate(10);
      slots.free(a);
      slots.free(b);
      expect(slots.freeRuns).toEqual([{ offset: 0, count: 30 }]);
    });

    it('merges with both neighbours at once', () => {
      const slots = createSlotAllocator(30);
      const a = slots.allocate(10);
      const b = slots.allocate(10);
      const c = slots.allocate(10);
      slots.free(a);
      slots.free(c);
      expect(slots.freeRuns).toEqual([
        { offset: 0, count: 10 },
        { offset: 20, count: 10 },
      ]);
      slots.free(b);
      expect(slots.freeRuns).toEqual([{ offset: 0, count: 30 }]);
      expect(slots.largestFree).toBe(30);
    });

    it('does not merge runs that are not adjacent', () => {
      const slots = createSlotAllocator(40);
      const a = slots.allocate(10);
      slots.allocate(10);
      const c = slots.allocate(10);
      slots.free(a);
      slots.free(c);
      expect(slots.freeRuns).toEqual([
        { offset: 0, count: 10 },
        { offset: 20, count: 20 },
      ]);
    });

    it('survives a full load/unload cycle without fragmenting', () => {
      const slots = createSlotAllocator(1000);
      for (let round = 0; round < 20; round += 1) {
        const ranges = [slots.allocate(300), slots.allocate(400), slots.allocate(250)];
        // Free in a different order each round, which is what a real unload looks like.
        for (const range of round % 2 === 0 ? ranges : [...ranges].reverse()) slots.free(range);
        expect(slots.freeRuns).toEqual([{ offset: 0, count: 1000 }]);
      }
    });
  });

  describe('free validation', () => {
    it('rejects an offset that was never allocated', () => {
      const slots = createSlotAllocator(10);
      expect(() => {
        slots.free({ offset: 4, count: 2 });
      }).toThrow(/never allocated/);
    });

    it('rejects a double free', () => {
      const slots = createSlotAllocator(10);
      const a = slots.allocate(4);
      slots.free(a);
      expect(() => {
        slots.free(a);
      }).toThrow(/never allocated/);
    });

    it('rejects a partial free', () => {
      const slots = createSlotAllocator(10);
      const a = slots.allocate(4);
      expect(() => {
        slots.free({ offset: a.offset, count: 2 });
      }).toThrow(/free the exact range/);
    });
  });

  it('reset drops every allocation', () => {
    const slots = createSlotAllocator(10);
    slots.allocate(4);
    slots.reset();
    expect(slots.used).toBe(0);
    expect(slots.freeRuns).toEqual([{ offset: 0, count: 10 }]);
    // The old range is gone, so the offset is allocatable again.
    expect(slots.allocate(10)).toEqual({ offset: 0, count: 10 });
  });
});
