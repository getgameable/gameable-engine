// First-fit slot allocator over one splat sink's capacity.
//
// Ranges are handed out once per branch at load and released on dispose, so the
// allocation pattern is a handful of long-lived blocks rather than churn. First
// fit over a sorted free list is therefore the right shape: it coalesces on free,
// it is deterministic (so a test can assert exact offsets), and it never moves an
// existing range — which matters because the sort's index -> splat map is only
// valid while offsets hold still.

import type { SlotRange } from '../splatSink.js';

interface Block {
  offset: number;
  count: number;
}

/**
 * A deterministic first-fit allocator over `[0, capacity)`.
 *
 * @example
 * ```ts
 * import { SlotAllocator } from 'gameable/character';
 *
 * const slots = new SlotAllocator(262144);
 * const head = slots.allocate(65536); // { offset: 0, count: 65536 }
 * slots.free(head);
 * ```
 */
export class SlotAllocator {
  readonly capacity: number;
  private freeList: Block[];

  constructor(capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 0) {
      throw new RangeError(
        `SlotAllocator: capacity must be a non-negative integer, got ${String(capacity)}`,
      );
    }
    this.capacity = capacity;
    this.freeList = capacity > 0 ? [{ offset: 0, count: capacity }] : [];
  }

  /**
   * Slots not currently owned by any range.
   *
   * @returns The total free slot count, which may be spread over several blocks
   * and so is an upper bound on the largest allocation that can still succeed.
   */
  get available(): number {
    return this.freeList.reduce((total, block) => total + block.count, 0);
  }

  /**
   * The free list, for tests and `memoryReport()`. Copied, never the live array.
   *
   * @returns The free blocks in ascending offset order, each a fresh object, so a
   * caller cannot corrupt the allocator by mutating what it reads.
   */
  blocks(): SlotRange[] {
    return this.freeList.map((block) => ({ offset: block.offset, count: block.count }));
  }

  /**
   * Reserve `count` contiguous slots.
   *
   * Throws rather than returning null: a branch that cannot be placed renders
   * nothing at all, and a silent null would surface as a character missing one
   * region with no error anywhere.
   *
   * @param count How many splat slots the branch needs; a positive integer.
   * @returns The reserved range: `offset` is the branch's slot offset into the
   * sink's storage buffers and `count` echoes the request.
   */
  allocate(count: number): SlotRange {
    if (!Number.isInteger(count) || count <= 0) {
      throw new RangeError(
        `SlotAllocator.allocate: count must be a positive integer, got ${String(count)}`,
      );
    }
    for (let index = 0; index < this.freeList.length; index++) {
      const block = this.freeList[index];
      if (block.count < count) continue;
      const range: SlotRange = { offset: block.offset, count };
      if (block.count === count) this.freeList.splice(index, 1);
      else {
        block.offset += count;
        block.count -= count;
      }
      return range;
    }
    throw new Error(
      `SlotAllocator: no contiguous run of ${String(count)} slots (capacity ${String(this.capacity)}, ` +
        `${String(this.available)} free in ${String(this.freeList.length)} block(s)) — the splat sink is too small for this character`,
    );
  }

  /**
   * Release a range and coalesce with its neighbours.
   *
   * Overlap with an already-free range throws: it means two owners believe they
   * hold the same slots, which renders one branch's gaussians at another's pose.
   *
   * @param range The range to give back, exactly as {@link SlotAllocator.allocate}
   * returned it; it must lie inside the capacity and must not already be free.
   */
  free(range: SlotRange): void {
    const { offset, count } = range;
    if (!Number.isInteger(offset) || !Number.isInteger(count) || count <= 0 || offset < 0) {
      throw new RangeError(`SlotAllocator.free: not a range (${String(offset)}, ${String(count)})`);
    }
    if (offset + count > this.capacity) {
      throw new RangeError(
        `SlotAllocator.free: [${String(offset)}, ${String(offset + count)}) runs past capacity ${String(this.capacity)}`,
      );
    }
    for (const block of this.freeList) {
      if (offset < block.offset + block.count && block.offset < offset + count) {
        throw new Error(
          `SlotAllocator.free: [${String(offset)}, ${String(offset + count)}) is already free — double release`,
        );
      }
    }
    this.freeList.push({ offset, count });
    this.freeList.sort((a, b) => a.offset - b.offset);
    const merged: Block[] = [];
    for (const block of this.freeList) {
      const last = merged.length > 0 ? merged[merged.length - 1] : null;
      if (last && last.offset + last.count === block.offset) last.count += block.count;
      else merged.push({ ...block });
    }
    this.freeList = merged;
  }
}
