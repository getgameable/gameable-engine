/**
 * First-fit slot allocation over one splat buffer.
 *
 * One character is one `AnimatedGaussianSplat`, and every branch of that character — head,
 * body, eyes, hair — lives in a slot range inside it, so the whole avatar sorts as a unit.
 * That makes the allocator the thing that hands out those ranges.
 *
 * First-fit, not best-fit: ranges are large, few and long-lived (a branch is allocated when
 * the character loads and freed when it unloads), so fit quality is worth less than
 * predictability. Frees coalesce with both neighbours immediately, which is what keeps a
 * load/unload cycle from fragmenting the buffer.
 */

/** A contiguous run of gaussian slots. */
export interface SlotRange {
  /** Index of the first slot. */
  readonly offset: number;
  /** How many slots. Always at least 1. */
  readonly count: number;
}

/** A free run, mutable because the allocator merges and splits them in place. */
interface FreeRun {
  offset: number;
  count: number;
}

/** Hands out and reclaims slot ranges inside a fixed capacity. */
export interface SlotAllocator {
  /** Total slots. */
  readonly capacity: number;
  /** Slots currently handed out. */
  readonly used: number;
  /**
   * Slots not handed out. Equals `capacity - used`.
   *
   * Named `available` rather than `free` because `free` is the method next to it, and a
   * property cannot be both.
   */
  readonly available: number;
  /** The largest range `allocate` could satisfy right now. */
  readonly largestFree: number;
  /** The free runs, low offset first. Exposed for tests and for the debug overlay. */
  readonly freeRuns: readonly SlotRange[];

  /**
   * Take the first free run large enough.
   *
   * @param count How many slots. Must be a positive integer.
   * @returns The range.
   * @throws {SlotAllocationError} When nothing is large enough, or `RangeError` when `count`
   *   is not a positive integer.
   */
  allocate(count: number): SlotRange;

  /**
   * Give a range back, coalescing with either neighbour.
   *
   * @param range A range from `allocate`.
   * @returns Nothing.
   * @throws {Error} When the range was not allocated, or was already freed.
   */
  free(range: SlotRange): void;

  /**
   * Drop every allocation and return to one free run.
   *
   * @returns Nothing.
   */
  reset(): void;
}

/** An allocation request that cannot be satisfied. */
export class SlotAllocationError extends Error {
  /** Slots that were asked for. */
  readonly requested: number;
  /** The largest run available at the time. */
  readonly largestFree: number;

  /**
   * Build a slot allocation error.
   *
   * @param message What went wrong.
   * @param requested Slots requested.
   * @param largestFree Largest free run at the time.
   */
  constructor(message: string, requested: number, largestFree: number) {
    super(message);
    this.name = 'SlotAllocationError';
    this.requested = requested;
    this.largestFree = largestFree;
  }
}

/**
 * Build a slot allocator over `capacity` slots.
 *
 * @param capacity Total slots. Must be a positive integer.
 * @returns An allocator with one free run covering everything.
 *
 * @example
 * ```ts
 * import { createSlotAllocator } from 'gameable/splat';
 *
 * const slots = createSlotAllocator(1000);
 * const head = slots.allocate(400);
 * console.log(head.offset, head.count); // 0 400
 * slots.free(head);
 * console.log(slots.available); // 1000
 * ```
 */
export function createSlotAllocator(capacity: number): SlotAllocator {
  if (!Number.isInteger(capacity) || capacity <= 0) {
    throw new RangeError(
      `@gameable/splat: capacity must be a positive integer, got ${String(capacity)}`,
    );
  }

  const runs: FreeRun[] = [{ offset: 0, count: capacity }];
  const live = new Map<number, number>();
  let used = 0;

  /**
   * Total free slots across every run.
   *
   * @returns Slots not handed out.
   */
  function freeCount(): number {
    return capacity - used;
  }

  const allocator: SlotAllocator = {
    capacity,

    get used() {
      return used;
    },

    get available() {
      return freeCount();
    },

    get largestFree() {
      let max = 0;
      for (const run of runs) if (run.count > max) max = run.count;
      return max;
    },

    get freeRuns() {
      return runs.map((r) => ({ offset: r.offset, count: r.count }));
    },

    allocate(count) {
      if (!Number.isInteger(count) || count <= 0) {
        throw new RangeError(
          `@gameable/splat: allocate(count) needs a positive integer, got ${String(count)}`,
        );
      }

      for (const [i, run] of runs.entries()) {
        if (run.count < count) continue;

        const offset = run.offset;
        if (run.count === count) runs.splice(i, 1);
        else {
          run.offset += count;
          run.count -= count;
        }

        live.set(offset, count);
        used += count;
        return { offset, count };
      }

      throw new SlotAllocationError(
        `@gameable/splat: cannot allocate ${String(count)} slots; ${String(freeCount())} free ` +
          `in ${String(runs.length)} run(s), largest ${String(allocator.largestFree)}. Raise the ` +
          'splat capacity, or free a range first.',
        count,
        allocator.largestFree,
      );
    },

    free(range) {
      const held = live.get(range.offset);
      if (held === undefined) {
        throw new Error(
          `@gameable/splat: free() at offset ${String(range.offset)} was never allocated, or ` +
            'has already been freed',
        );
      }
      if (held !== range.count) {
        throw new Error(
          `@gameable/splat: free() at offset ${String(range.offset)} covers ${String(range.count)} ` +
            `slots but ${String(held)} were allocated; free the exact range you were given`,
        );
      }

      live.delete(range.offset);
      used -= held;

      // Insert in offset order, then merge with the run after and the run before.
      let i = 0;
      while (i < runs.length && runs[i].offset < range.offset) i += 1;
      const inserted: FreeRun = { offset: range.offset, count: held };
      runs.splice(i, 0, inserted);

      if (i + 1 < runs.length && inserted.offset + inserted.count === runs[i + 1].offset) {
        inserted.count += runs[i + 1].count;
        runs.splice(i + 1, 1);
      }
      if (i > 0 && runs[i - 1].offset + runs[i - 1].count === inserted.offset) {
        runs[i - 1].count += inserted.count;
        runs.splice(i, 1);
      }
    },

    reset() {
      runs.length = 0;
      runs.push({ offset: 0, count: capacity });
      live.clear();
      used = 0;
    },
  };

  return allocator;
}
