/**
 * `PoseWriter` — packed transform and body rows written onto the records.
 *
 * Two writers share one rule from the page: a rotation the guest wrote this
 * tick wins over the physics step that follows it, while position still
 * follows physics; the tick of the guest's write is the record's `authoredAt`.
 * Lane writes move `poseSerial`, a `VISIBLE` row moves `stateSerial`. A lane
 * that did not change moves nothing, so a body asleep on a shelf costs
 * comparisons and replicates nothing. A row flagged `TELEPORT` stamps the
 * record's `teleportedAt` (and `poseSerial`), so clients snap rather than glide.
 */
import { TRANSFORM_FLAGS, TRANSFORM_STRIDE } from '@gameable/sdk';

import type { WorldRecord } from './WorldRecord';

/** Floats per packed body row, as `PhysicsWorld.readBodies` writes them. */
const BODY_STRIDE = 15;

/**
 * Copy `dst.length` floats from `src` at `at` into `dst`, reporting a change.
 *
 * @param dst The record's lanes.
 * @param src The packed rows.
 * @param at First float to read.
 * @returns True when at least one lane changed.
 */
function writeLanes(dst: Float32Array, src: Float32Array, at: number): boolean {
  let changed = false;
  for (let i = 0; i < dst.length; i += 1) {
    const value = src[at + i];
    if (dst[i] !== value) {
      dst[i] = value;
      changed = true;
    }
  }
  return changed;
}

/**
 * Applies the guest's transform rows and the physics step's body rows.
 *
 * @example
 * ```ts
 * // Internal to the server adapter:
 * const poses = new PoseWriter(world);
 * poses.applyTransforms(out.transforms, rows);
 * poses.applyBodyRows(bodyRows, bodyCount);
 * ```
 */
export class PoseWriter {
  private readonly world: WorldRecord;

  /** @param world The records written to. */
  constructor(world: WorldRecord) {
    this.world = world;
  }

  /**
   * Write the lanes each row's flags name.
   *
   * @param rows Stride-12 rows: entity, flags, position, rotation, scale.
   * @param count Rows to read.
   */
  applyTransforms(rows: Float32Array, count: number): void {
    for (let row = 0; row < count; row += 1) {
      const o = row * TRANSFORM_STRIDE;
      const entity = rows[o] | 0;
      if (entity <= 0) continue;
      const record = this.world.get(entity);
      if (record === undefined) continue;
      const flags = rows[o + 1] | 0;
      let changed = false;
      let shown = false;
      if ((flags & TRANSFORM_FLAGS.POSITION) !== 0) {
        changed = writeLanes(record.position, rows, o + 2);
      }
      if ((flags & TRANSFORM_FLAGS.ROTATION) !== 0) {
        record.authoredAt = this.world.frame;
        changed = writeLanes(record.rotation, rows, o + 5) || changed;
      }
      if ((flags & TRANSFORM_FLAGS.SCALE) !== 0) {
        changed = writeLanes(record.scale, rows, o + 9) || changed;
      }
      if ((flags & TRANSFORM_FLAGS.VISIBLE) !== 0 && !record.visible) {
        record.visible = true;
        shown = true;
      }
      if ((flags & TRANSFORM_FLAGS.TELEPORT) !== 0) {
        record.teleportedAt = this.world.frame;
        changed = true;
      }
      if (changed) this.world.touchPose(record);
      if (shown) this.world.touchState(record);
    }
  }

  /**
   * Write post-step position and rotation onto the entity each body drives.
   *
   * @param rows Stride-15 rows from `PhysicsWorld.readBodies`.
   * @param count Rows to read; `rows` may be longer.
   */
  applyBodyRows(rows: Float32Array, count: number): void {
    const limit = Math.min(count, Math.floor(rows.length / BODY_STRIDE));
    for (let row = 0; row < limit; row += 1) {
      const o = row * BODY_STRIDE;
      const entity = this.world.entityOfBody(rows[o] | 0);
      if (entity === 0) continue;
      const record = this.world.get(entity);
      if (record === undefined) continue;
      let changed = writeLanes(record.position, rows, o + 1);
      if (record.authoredAt !== this.world.frame) {
        changed = writeLanes(record.rotation, rows, o + 4) || changed;
      }
      if (changed) this.world.touchPose(record);
    }
  }
}
