/**
 * The post-step body rows a loop reads once per physics step, in one reused
 * buffer. Shared by the page loop and the server loop.
 */
import type { PhysicsService } from '@gameable/physics-jolt';

import { BODY_STRIDE } from './bodyShapes';

/**
 * A stride-15 body-row buffer that grows by doubling and is otherwise reused.
 *
 * @example
 * ```ts
 * import { BodyRows } from './adapter/BodyRows';
 *
 * const rows = new BodyRows(1024);
 * console.log(rows.count, rows.rows.length); // 0 15360
 * ```
 */
export class BodyRows {
  /** The rows; replaced (never shrunk) only when a step needs more room. */
  rows: Float32Array;
  /** Rows the last {@link BodyRows.read} filled in. */
  count = 0;

  /** @param initialRows Rows to reserve before the first growth; at least 1. */
  constructor(initialRows: number) {
    this.rows = new Float32Array(Math.max(1, initialRows) * BODY_STRIDE);
  }

  /**
   * Read the rows of the step that just finished.
   *
   * Sized before the read, not after it: `readBodies` fills what it is given
   * and reports what it needed, so growing afterwards means reading twice.
   *
   * @param world The physics world that just stepped.
   * @returns The number of rows read, also kept in {@link BodyRows.count}.
   */
  read(world: PhysicsService): number {
    const needed = world.movingBodyCount * BODY_STRIDE;
    if (needed > this.rows.length) {
      let size = this.rows.length;
      while (size < needed) size *= 2;
      this.rows = new Float32Array(size);
    }
    this.count = world.readBodies(this.rows);
    return this.count;
  }
}
