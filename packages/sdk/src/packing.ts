/**
 * The zero-allocation edge of the boundary.
 *
 * Everything that crosses per frame is packed here: entity transforms out
 * (stride 12) and rigid-body transforms in (stride 15). Both directions use
 * preallocated typed arrays, memoised subarrays and dirty flags, so a steady
 * state tick allocates nothing at all.
 */
import { RigidBody, Transform, Velocity } from './ecs';
import { requireRuntime } from './state';

/** Floats per row of `frame-output.transforms`. */
export const TRANSFORM_STRIDE = 12;

/** Floats per row of `frame-input.bodies`. */
export const BODY_STRIDE = 15;

/**
 * Meaning of lane 1 of a transform row, matching WIT `transform-flags`.
 */
export const TRANSFORM_FLAGS = Object.freeze({
  /** Position lanes are meaningful. */
  POSITION: 1,
  /** Rotation lanes are meaningful. */
  ROTATION: 2,
  /** Scale lanes are meaningful. */
  SCALE: 4,
  /** Visibility changed; the entity is visible. */
  VISIBLE: 8,
  /** Do not interpolate towards this transform. */
  TELEPORT: 16,
  /** The entity is gone; drop it after applying. */
  DESTROYED: 32,
});

/** `POSITION | ROTATION | SCALE`, what a freshly spawned entity needs. */
export const TRANSFORM_ALL =
  TRANSFORM_FLAGS.POSITION | TRANSFORM_FLAGS.ROTATION | TRANSFORM_FLAGS.SCALE;

/**
 * Packs entity transforms into `frame-output.transforms`.
 *
 * One row is written per entity whose dirty flags are non-zero, in ascending
 * entity order — deterministic, and cheaper than a bitecs query for the
 * densely packed id space the SDK mints.
 */
export class TransformPacker {
  /** Per-entity `transform-flags` accumulated since the last `pack`. */
  readonly dirty: Uint8Array;

  /**
   * Highest entity id `pack` scans to.
   *
   * It rises when a higher id is marked and falls back to the last dirty id
   * every `pack`, so a level that spawned 4,000 entities and despawned all but
   * ten does not keep scanning 4,000 slots a frame.
   */
  highWater = 0;

  private readonly buf: Float32Array;
  private readonly subs: (Float32Array | undefined)[];
  private readonly emptyRow: Float32Array;

  /**
   * @param maxEntities Entity ceiling; the buffer holds this many rows.
   */
  constructor(maxEntities: number) {
    this.dirty = new Uint8Array(maxEntities);
    this.buf = new Float32Array(maxEntities * TRANSFORM_STRIDE);
    this.subs = new Array<Float32Array | undefined>(maxEntities + 1).fill(undefined);
    // The one row returned when nothing is dirty: entity 0, flags 0. jco's
    // list lifter rejects the pointer QuickJS returns for a zero-length list,
    // so the guest never emits one.
    this.emptyRow = new Float32Array(TRANSFORM_STRIDE);
  }

  /**
   * Accumulate dirty flags for one entity.
   *
   * @param entity Entity id.
   * @param flags Any combination of `TRANSFORM_FLAGS`.
   * @returns Nothing.
   */
  mark(entity: number, flags: number): void {
    if (entity <= 0 || entity >= this.dirty.length) return;
    this.dirty[entity] = (this.dirty[entity] ?? 0) | flags;
    if (entity > this.highWater) this.highWater = entity;
  }

  /**
   * Forget every pending flag, for example after `restore`.
   *
   * @returns Nothing.
   */
  clear(): void {
    this.dirty.fill(0);
    this.highWater = 0;
  }

  /**
   * Write every dirty entity into the packed buffer and clear the flags.
   *
   * @returns A memoised subarray of the internal buffer. The same row count
   *   always returns the same object, which is what makes a steady-state tick
   *   allocation-free; never retain it across frames.
   */
  pack(): Float32Array {
    const { buf, dirty } = this;
    // The SoA lanes are read once here, not re-resolved per entity per lane.
    // `configureEcs` replaces the arrays, so they are never cached across
    // calls — only across the loop below.
    const { x, y, z, qx, qy, qz, qw, sx, sy, sz } = Transform;
    const top = this.highWater;
    let rows = 0;
    let lastDirty = 0;
    for (let e = 1; e <= top; e += 1) {
      const flags = dirty[e] ?? 0;
      if (flags === 0) continue;
      dirty[e] = 0;
      lastDirty = e;
      const o = rows * TRANSFORM_STRIDE;
      buf[o] = e;
      buf[o + 1] = flags;
      buf[o + 2] = x[e] ?? 0;
      buf[o + 3] = y[e] ?? 0;
      buf[o + 4] = z[e] ?? 0;
      buf[o + 5] = qx[e] ?? 0;
      buf[o + 6] = qy[e] ?? 0;
      buf[o + 7] = qz[e] ?? 0;
      buf[o + 8] = qw[e] ?? 1;
      buf[o + 9] = sx[e] ?? 1;
      buf[o + 10] = sy[e] ?? 1;
      buf[o + 11] = sz[e] ?? 1;
      rows += 1;
    }
    // Decay: everything above the last dirty entity was clean this frame, so
    // the next scan can stop there.
    this.highWater = lastDirty;
    if (rows === 0) return this.emptyRow;
    const cached = this.subs[rows];
    if (cached) return cached;
    const fresh = this.buf.subarray(0, rows * TRANSFORM_STRIDE);
    this.subs[rows] = fresh;
    return fresh;
  }
}

/**
 * Maps host body ids back onto entities and ingests `frame-input.bodies`.
 *
 * The incoming list is a `Float32Array` in both modes — jco lifts WIT
 * `list<f32>` into one, and direct mode hands the guest the host's own buffer
 * (see `packages/sdk/src/wit/generated/interfaces/gameable-engine-game.d.ts`). It is
 * read purely by index and never copied.
 */
export class BodyIndex {
  /** Body id to entity id. Index 0 is unused: body 0 means "no body". */
  readonly bodyToEntity: Uint32Array;

  /** Number of rows seen in the most recent `ingest`. */
  lastRowCount = 0;

  /**
   * @param maxBodies Body-id ceiling.
   */
  constructor(maxBodies: number) {
    this.bodyToEntity = new Uint32Array(maxBodies);
  }

  /**
   * Associate a body with the entity it drives.
   *
   * @param body Body id.
   * @param entity Entity id.
   * @returns Nothing.
   */
  bind(body: number, entity: number): void {
    if (body > 0 && body < this.bodyToEntity.length) this.bodyToEntity[body] = entity;
  }

  /**
   * Forget a body.
   *
   * @param body Body id.
   * @returns Nothing.
   */
  unbind(body: number): void {
    if (body > 0 && body < this.bodyToEntity.length) this.bodyToEntity[body] = 0;
  }

  /**
   * Forget every body.
   *
   * @returns Nothing.
   */
  clear(): void {
    this.bodyToEntity.fill(0);
    this.lastRowCount = 0;
  }

  /**
   * Copy post-step body transforms into `Transform` and `Velocity`.
   *
   * **This does not mark the entity moved**, and that is the point. The host
   * owns a body-driven entity's transform: the physics module hands the same
   * rows straight to the adapter after it steps, so the object in the scene is
   * already where the body is. Marking here would send all twelve floats back
   * across the boundary in `frame-output.transforms` for the host to write a
   * second time — the same numbers, one step later.
   *
   * What the guest gets is still the truth for gameplay: read `Transform.x[e]`
   * to aim at something, `Velocity` to decide whether it is running. A system
   * that *overwrites* those lanes is authoring a move rather than observing
   * one, and has to say so with `markMoved` — see {@link markMoved}.
   *
   * @param bodies The packed rows, stride 15.
   * @returns Nothing.
   */
  ingest(bodies: ArrayLike<number>): void {
    const n = bodies.length;
    this.lastRowCount = (n / BODY_STRIDE) | 0;
    const map = this.bodyToEntity;
    // One property read per lane for the whole list, not per row.
    const { x, y, z, qx, qy, qz, qw } = Transform;
    const { x: vx, y: vy, z: vz, ax, ay, az } = Velocity;
    for (let i = 0; i + BODY_STRIDE <= n; i += BODY_STRIDE) {
      const body = (bodies[i] ?? 0) | 0;
      if (body <= 0 || body >= map.length) continue;
      const e = map[body] ?? 0;
      if (e === 0) continue;
      x[e] = bodies[i + 1] ?? 0;
      y[e] = bodies[i + 2] ?? 0;
      z[e] = bodies[i + 3] ?? 0;
      qx[e] = bodies[i + 4] ?? 0;
      qy[e] = bodies[i + 5] ?? 0;
      qz[e] = bodies[i + 6] ?? 0;
      qw[e] = bodies[i + 7] ?? 1;
      vx[e] = bodies[i + 8] ?? 0;
      vy[e] = bodies[i + 9] ?? 0;
      vz[e] = bodies[i + 10] ?? 0;
      ax[e] = bodies[i + 11] ?? 0;
      ay[e] = bodies[i + 12] ?? 0;
      az[e] = bodies[i + 13] ?? 0;
      RigidBody.groundState[e] = bodies[i + 14] ?? 0;
    }
  }

  /**
   * The body id driving an entity, or 0.
   *
   * @param entity Entity id.
   * @returns The body id, or 0 when the entity has none.
   */
  bodyOf(entity: number): number {
    return RigidBody.handle[entity] ?? 0;
  }
}

/**
 * Tell the packer an entity's `Transform` changed.
 *
 * `spawn` and the built-in velocity integration mark for you. Two cases they
 * do not cover: a system that writes `Transform.x[e]` (or any other lane) by
 * hand, and a body-driven entity, whose transform the host now owns outright —
 * `BodyIndex.ingest` copies the physics rows in for the guest to *read* and
 * deliberately does not mark them. Either way, nothing notices the write, the
 * row is never packed and the host never moves the object. Call this after
 * such a write. To move a physics body, send a command (`setBodyTransform`)
 * rather than writing the lane.
 *
 * @param entity Entity id. Out-of-range ids are ignored.
 * @param flags Which lanes changed; defaults to position, rotation and scale.
 * @returns Nothing.
 *
 * @example
 * ```ts
 * import { Transform, TRANSFORM_FLAGS, markMoved } from 'gameable';
 *
 * Transform.y[e] = Transform.y[e] + 0.1;
 * markMoved(e, TRANSFORM_FLAGS.POSITION);
 * ```
 */
export function markMoved(entity: number, flags: number = TRANSFORM_ALL): void {
  requireRuntime().packer.mark(entity, flags);
}
