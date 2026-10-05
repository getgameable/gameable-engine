/**
 * `RowInterpolator` — snapshot interpolation for replicated rows.
 *
 * Rows arrive at the room's send rate (20 Hz by default) and the page steps
 * at 60 Hz. Writing each row straight into the transform store moves an
 * entity on one step in three and holds it still on the others. So each
 * entity keeps its last two rows, tagged with the authority frame they
 * describe, and every fixed step writes the blend at a render frame about one
 * send interval behind the newest row: always between two real poses.
 * A TELEPORT row snaps both ends to itself. The local player's own entity is
 * treated the same way, unless the page predicts it: then {@link
 * RowInterpolator.own} names it, and its position is the predictor's
 * (rotation and scale still blend from its rows).
 */
import { RowFlag } from '../protocol/constants.js';
import type { ClientLoopAdapter } from './ClientLoopAdapter.js';

/** Position (3), rotation (4), scale (3). */
const POSE = 10;
const ALL_LANES = RowFlag.POSITION | RowFlag.ROTATION | RowFlag.SCALE;

/** One entity's two most recent poses. */
interface Track {
  entity: number;
  aFrame: number;
  bFrame: number;
  readonly a: Float32Array;
  readonly b: Float32Array;
  /** The next write snaps (TELEPORT). */
  snap: boolean;
  /** The next write shows the entity (VISIBLE). */
  show: boolean;
  /** The last write reached `b`; nothing to do until a new row. */
  settled: boolean;
}

/** Each entity's last two rows, and the blend written every fixed step. */
export class RowInterpolator {
  private readonly tracks: Track[] = [];
  private readonly index = new Map<number, number>();
  private readonly position = new Float32Array(3);
  private readonly rotation = new Float32Array(4);
  private readonly scale = new Float32Array(3);
  /** One send interval, in fixed steps. */
  private delay = 3;
  private newest = -1;
  private renderFrame = -1;
  /** An entity whose position this leaves alone (the predicted player's), or 0. */
  own = 0;

  /**
   * @param fixedHz The page's fixed steps per second.
   * @param sendHz The room's rows per second.
   */
  configure(fixedHz: number, sendHz: number): void {
    this.delay = Math.max(1, Math.round(fixedHz / Math.max(1, sendHz)));
  }

  /**
   * An entity was introduced: its spawn pose is where it blends from.
   *
   * @param entity The entity.
   * @param pose Position, rotation and scale, 10 numbers.
   */
  spawn(entity: number, pose: ArrayLike<number>): void {
    const track = this.track(entity);
    for (let i = 0; i < POSE; i += 1) track.a[i] = track.b[i] = pose[i];
    track.aFrame = track.bFrame = -1;
    track.snap = false;
    track.show = false;
    track.settled = true;
  }

  /**
   * One decoded row.
   *
   * @param entity The entity.
   * @param flags Its `RowFlag` bits.
   * @param frame The authority frame the row describes.
   * @param position Position xyz (read when POSITION is set).
   * @param rotation Rotation xyzw (read when ROTATION is set).
   * @param scale Scale xyz (read when SCALE is set).
   */
  push(
    entity: number,
    flags: number,
    frame: number,
    position: Float32Array,
    rotation: Float32Array,
    scale: Float32Array,
  ): void {
    const track = this.track(entity);
    const a = track.a;
    const b = track.b;
    a.set(b);
    track.aFrame = track.bFrame;
    if ((flags & RowFlag.POSITION) !== 0) b.set(position, 0);
    if ((flags & RowFlag.ROTATION) !== 0) b.set(rotation, 3);
    if ((flags & RowFlag.SCALE) !== 0) b.set(scale, 7);
    track.bFrame = frame;
    if ((flags & RowFlag.TELEPORT) !== 0 || track.aFrame < 0) {
      a.set(b);
      track.aFrame = frame;
      track.snap = (flags & RowFlag.TELEPORT) !== 0;
    }
    if ((flags & RowFlag.VISIBLE) !== 0) track.show = true;
    track.settled = false;
    if (frame > this.newest) this.newest = frame;
  }

  /** @param entity An entity that is gone. */
  remove(entity: number): void {
    const at = this.index.get(entity);
    if (at === undefined) return;
    const last = this.tracks.length - 1;
    const moved = this.tracks[last];
    this.tracks[at] = moved;
    this.index.set(moved.entity, at);
    this.tracks.length = last;
    this.index.delete(entity);
  }

  /** Forget every entity (a new welcome). The render clock resyncs on the next row. */
  clear(): void {
    this.tracks.length = 0;
    this.index.clear();
    this.renderFrame = -1;
    this.newest = -1;
  }

  /**
   * One fixed step: advance the render frame and write each moving entity's blend.
   *
   * @param adapter Where the poses go.
   */
  step(adapter: ClientLoopAdapter): void {
    if (this.newest < 0) return;
    const target = this.newest - this.delay;
    const next = this.renderFrame + 1;
    // Follow the newest row one interval behind; resync after a stall or a burst.
    this.renderFrame =
      this.renderFrame < 0 || Math.abs(next - target) > 2 * this.delay
        ? target
        : Math.min(next, this.newest);
    const tracks = this.tracks;
    for (let i = 0; i < tracks.length; i += 1) {
      const track = tracks[i];
      if (track.settled) continue;
      const span = track.bFrame - track.aFrame;
      const u = span <= 0 ? 1 : Math.min(1, Math.max(0, (this.renderFrame - track.aFrame) / span));
      this.blend(track, u);
      let flags = track.entity === this.own ? ALL_LANES & ~RowFlag.POSITION : ALL_LANES;
      if (track.snap) flags |= RowFlag.TELEPORT;
      if (track.show) flags |= RowFlag.VISIBLE;
      adapter.setTransformFromHost(track.entity, flags, this.position, this.rotation, this.scale);
      track.snap = false;
      track.show = false;
      if (u >= 1) track.settled = true;
    }
  }

  /**
   * @param track The entity.
   * @param u 0 at `a`, 1 at `b`.
   */
  private blend(track: Track, u: number): void {
    const a = track.a;
    const b = track.b;
    for (let i = 0; i < 3; i += 1) this.position[i] = a[i] + (b[i] - a[i]) * u;
    for (let i = 0; i < 3; i += 1) this.scale[i] = a[7 + i] + (b[7 + i] - a[7 + i]) * u;
    // Normalised lerp, through the shorter arc.
    const dot = a[3] * b[3] + a[4] * b[4] + a[5] * b[5] + a[6] * b[6];
    const sign = dot < 0 ? -1 : 1;
    let length = 0;
    for (let i = 0; i < 4; i += 1) {
      const q = a[3 + i] + (sign * b[3 + i] - a[3 + i]) * u;
      this.rotation[i] = q;
      length += q * q;
    }
    const inverse = length > 0 ? 1 / Math.sqrt(length) : 1;
    for (let i = 0; i < 4; i += 1) this.rotation[i] *= inverse;
  }

  /**
   * @param entity The entity.
   * @returns Its track, made (with an identity pose) on first sight.
   */
  private track(entity: number): Track {
    const at = this.index.get(entity);
    if (at !== undefined) return this.tracks[at];
    const track: Track = {
      entity,
      aFrame: -1,
      bFrame: -1,
      a: new Float32Array([0, 0, 0, 0, 0, 0, 1, 1, 1, 1]),
      b: new Float32Array([0, 0, 0, 0, 0, 0, 1, 1, 1, 1]),
      snap: false,
      show: false,
      settled: true,
    };
    this.index.set(entity, this.tracks.length);
    this.tracks.push(track);
    return track;
  }
}
