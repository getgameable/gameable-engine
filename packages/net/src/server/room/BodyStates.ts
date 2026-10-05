/**
 * `BodyStates` — the room's post-step body rows, read from the physics world
 * at most once per step and only when a player trailer asks (Task 8.1).
 */
import type { PhysicsWorld } from '@gameable/physics-jolt';

/** Floats per body row: id, position, rotation, linear and angular velocity, ground state. */
const STRIDE = 15;

/** What a trailer needs of the physics world. */
export type BodyReader = Pick<PhysicsWorld, 'readBodies' | 'movingBodyCount'>;

/**
 * The moving bodies' rows of the last step, ascending by body id as
 * `readBodies` writes them. {@link BodyStates.stale} is set by the
 * replicator after every step; the first {@link BodyStates.find} after it
 * reads the world again. The buffer grows by doubling and is otherwise
 * reused, so a steady room reads without allocating.
 *
 * @example
 * ```ts
 * import { BodyStates } from './BodyStates.js';
 *
 * const bodies = new BodyStates(engine.modules.get('physics'));
 * const at = bodies.find(3); // -1, or the offset of body 3's row in bodies.rows
 * ```
 */
export class BodyStates {
  /** The rows; replaced (never shrunk) only when the world outgrows it. */
  rows = new Float32Array(16 * STRIDE);
  /** True when a step ran since the last read. */
  stale = true;
  private count = 0;

  /** @param reader The room's physics world, or null for a room without one. */
  constructor(private readonly reader: BodyReader | null) {}

  /**
   * @param body A body id.
   * @returns The offset of its row in {@link BodyStates.rows}, or -1 when it
   *   is not a moving body (or the room has no physics world).
   */
  find(body: number): number {
    if (this.reader === null) return -1;
    if (this.stale) this.read(this.reader);
    let lo = 0;
    let hi = this.count - 1;
    const rows = this.rows;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const id = rows[mid * STRIDE];
      if (id === body) return mid * STRIDE;
      if (id < body) lo = mid + 1;
      else hi = mid - 1;
    }
    return -1;
  }

  /** @param reader The world to read. */
  private read(reader: BodyReader): void {
    this.stale = false;
    const needed = reader.movingBodyCount * STRIDE;
    if (needed > this.rows.length) {
      let size = this.rows.length;
      while (size < needed) size *= 2;
      this.rows = new Float32Array(size);
    }
    this.count = Math.min(reader.readBodies(this.rows), (this.rows.length / STRIDE) | 0);
  }
}
