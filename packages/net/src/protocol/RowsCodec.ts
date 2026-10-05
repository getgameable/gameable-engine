/**
 * `RowsCodec` — the transform rows of one send, server to client.
 *
 * Layout, little-endian: an 11-byte header, then `count` rows.
 *
 * | Offset | Type | Field      |
 * | ------ | ---- | ---------- |
 * | 0      | u8   | kind = 2   |
 * | 1      | u32  | frame      |
 * | 5      | u32  | ack        |
 * | 9      | u16  | count      |
 *
 * Each row is `entity u32, flags u8`, then only the lanes its flags name, in
 * this order: position `3 x i32` millimetres (`RowFlag.POSITION`), rotation
 * `u32` smallest-three (`RowFlag.ROTATION`), scale `3 x f32` (`RowFlag.SCALE`:
 * exact, so a mirrored entity's -1 and a sky dome's 100 survive).
 * `RowFlag.VISIBLE` and `RowFlag.TELEPORT` carry no lanes. A row is 5 to 33
 * bytes. A decoded scale lane that is NaN or infinite is a malformed
 * frame.
 *
 * After the last row a frame may carry one player trailer (`PlayerTrailer`,
 * 34 bytes): the receiving player's own body and the input seq it follows,
 * for client-side prediction. A frame without it is the same bytes as
 * before the trailer existed, and a sink without a `player` method skips it.
 *
 * A decode walks the whole frame once to check it before the sink sees any
 * row, so a truncated or lying frame reaches the sink not at all.
 */
import {
  FrameKind,
  MAX_ROWS,
  PLAYER_TRAILER_BYTES,
  ROW_FLAG_MASK,
  RowFlag,
  ROWS_HEADER_BYTES,
} from './constants.js';
import { FrameCodec } from './FrameCodec.js';
import { PlayerTrailer } from './PlayerTrailer.js';
import { Quantizer } from './Quantizer.js';
import type { RowSink, RowSource, RowsHeader } from './types.js';

/**
 * Bytes of one row.
 *
 * @param flags - The row's `RowFlag` bits.
 * @returns 5 to 33.
 */
function rowBytes(flags: number): number {
  return (
    5 +
    (flags & RowFlag.POSITION ? 12 : 0) +
    (flags & RowFlag.ROTATION ? 4 : 0) +
    (flags & RowFlag.SCALE ? 12 : 0)
  );
}

/**
 * Encodes and decodes rows frames. Owns the one header object `decode`
 * returns, so neither direction allocates.
 *
 * @example
 * ```ts
 * const position = new Float32Array([1.5, 0, -2]);
 * const rotation = new Float32Array([0, 0, 0, 1]);
 * const scale = new Float32Array([1, 1, 1]);
 * const rows: RowSource = {
 *   count: 1,
 *   entity: () => 7,
 *   flags: () => RowFlag.POSITION | RowFlag.ROTATION,
 *   position: () => position,
 *   rotation: () => rotation,
 *   scale: () => scale,
 * };
 * const sink: RowSink = {
 *   position: new Float32Array(3),
 *   rotation: new Float32Array(4),
 *   scale: new Float32Array(3),
 *   row: (entity) => console.log(entity, sink.position),
 * };
 * const codec = new RowsCodec();
 * const out = new DataView(new ArrayBuffer(codec.frameBytes(rows)));
 * const bytes = codec.encode(out, 600, 12, rows);
 * codec.decode(new Uint8Array(out.buffer, 0, bytes), sink); // { frame: 600, ack: 12, count: 1, player: null }
 * ```
 */
export class RowsCodec extends FrameCodec {
  private readonly header: RowsHeader = { frame: 0, ack: 0, count: 0, player: null };
  private readonly quantizer = new Quantizer();
  private readonly trailer = new PlayerTrailer();

  /**
   * The bytes `encode` would write; flag bits beyond `RowFlag` are ignored.
   *
   * @param rows - The rows to size.
   * @returns The frame's length.
   */
  frameBytes(rows: RowSource): number {
    let bytes = ROWS_HEADER_BYTES;
    for (let i = 0; i < rows.count; i += 1) bytes += rowBytes(rows.flags(i) & ROW_FLAG_MASK);
    return rows.player ? bytes + PLAYER_TRAILER_BYTES : bytes;
  }

  /**
   * Writes one rows frame at the start of `out`; a non-finite scale lane is written as 1, one past the `f32` range as its limit.
   *
   * @param out - The send buffer, owned by the caller.
   * @param frame - The authority's fixed-step counter.
   * @param ack - The last input `seq` applied for the receiving player; also the trailer's seq.
   * @param rows - The rows to write, and `rows.player`'s trailer after them when it is set.
   * @returns Bytes written, or 0 (with nothing written) when `out` is too small
   * or `rows.count` is not an integer in `[0, MAX_ROWS]`.
   */
  encode(out: DataView, frame: number, ack: number, rows: RowSource): number {
    const count = rows.count;
    if (!Number.isInteger(count) || count < 0 || count > MAX_ROWS) return 0;
    const total = this.frameBytes(rows);
    if (out.byteLength < total) return 0;
    const q = this.quantizer;
    out.setUint8(0, FrameKind.ROWS);
    out.setUint32(1, frame >>> 0, true);
    out.setUint32(5, ack >>> 0, true);
    out.setUint16(9, count, true);
    let at = ROWS_HEADER_BYTES;
    for (let i = 0; i < count; i += 1) {
      const flags = rows.flags(i) & ROW_FLAG_MASK;
      out.setUint32(at, rows.entity(i) >>> 0, true);
      out.setUint8(at + 4, flags);
      at += 5;
      if (flags & RowFlag.POSITION) {
        const p = rows.position(i);
        out.setInt32(at, q.position(p[0]), true);
        out.setInt32(at + 4, q.position(p[1]), true);
        out.setInt32(at + 8, q.position(p[2]), true);
        at += 12;
      }
      if (flags & RowFlag.ROTATION) {
        const r = rows.rotation(i);
        out.setUint32(at, q.packQuat(r[0], r[1], r[2], r[3]), true);
        at += 4;
      }
      if (flags & RowFlag.SCALE) {
        const s = rows.scale(i);
        out.setFloat32(at, finiteOr1(s[0]), true);
        out.setFloat32(at + 4, finiteOr1(s[1]), true);
        out.setFloat32(at + 8, finiteOr1(s[2]), true);
        at += 12;
      }
    }
    const player = rows.player;
    if (player) this.trailer.write(out, at, ack, player);
    return total;
  }

  /**
   * Reads one rows frame, handing each row to `sink`.
   *
   * @param bytes - Exactly one received frame.
   * @param sink - Receives the rows, only once the whole frame has been checked.
   * @returns The frame's header in an object reused by the next call (its
   * `player` is the trailer, or null), or null (with the sink never called)
   * when `bytes` is not exactly one well-formed rows frame: too short for its
   * header or its rows, longer than its rows and not one whole trailer,
   * another kind, a flag bit outside `RowFlag` or `PlayerRowFlag`, a
   * non-finite scale or trailer lane, or sink arrays too short.
   */
  decode(bytes: Uint8Array, sink: RowSink): RowsHeader | null {
    if (!this.isKind(bytes, FrameKind.ROWS, ROWS_HEADER_BYTES, false)) return null;
    if (sink.position.length < 3 || sink.rotation.length < 4 || sink.scale.length < 3) return null;
    const count = this.u16(bytes, 9);
    let at = ROWS_HEADER_BYTES;
    for (let i = 0; i < count; i += 1) {
      if (at + 5 > bytes.length) return null;
      const flags = this.u8(bytes, at + 4);
      if ((flags & ~ROW_FLAG_MASK) !== 0) return null;
      const end = at + rowBytes(flags);
      if (end > bytes.length) return null;
      if (flags & RowFlag.SCALE && !this.finiteScale(bytes, end - 12)) return null;
      at = end;
    }
    const trailed = at !== bytes.length;
    if (trailed && !this.trailer.check(bytes, at)) return null;
    this.emit(bytes, count, sink);
    const header = this.header;
    header.frame = this.u32(bytes, 1);
    header.ack = this.u32(bytes, 5);
    header.count = count;
    header.player = trailed ? this.trailer.read(bytes, at) : null;
    if (header.player !== null) sink.player?.(header.player);
    return header;
  }

  /**
   * Whether a scale lane holds three finite floats.
   *
   * @param bytes - The frame, the lane already known to be in range.
   * @param at - The lane's offset.
   * @returns False when any of the three is NaN or infinite.
   */
  private finiteScale(bytes: Uint8Array, at: number): boolean {
    return (
      Number.isFinite(this.f32(bytes, at)) &&
      Number.isFinite(this.f32(bytes, at + 4)) &&
      Number.isFinite(this.f32(bytes, at + 8))
    );
  }

  /**
   * Hands a frame already checked by `decode` to the sink, row by row.
   *
   * @param bytes - The checked frame.
   * @param count - Its row count.
   * @param sink - The receiver.
   */
  private emit(bytes: Uint8Array, count: number, sink: RowSink): void {
    const q = this.quantizer;
    const { position, rotation, scale } = sink;
    let at = ROWS_HEADER_BYTES;
    for (let i = 0; i < count; i += 1) {
      const entity = this.u32(bytes, at);
      const flags = this.u8(bytes, at + 4);
      at += 5;
      if (flags & RowFlag.POSITION) {
        position[0] = q.unposition(this.i32(bytes, at));
        position[1] = q.unposition(this.i32(bytes, at + 4));
        position[2] = q.unposition(this.i32(bytes, at + 8));
        at += 12;
      }
      if (flags & RowFlag.ROTATION) {
        q.unpackQuat(this.u32(bytes, at), rotation, 0);
        at += 4;
      }
      if (flags & RowFlag.SCALE) {
        scale[0] = this.f32(bytes, at);
        scale[1] = this.f32(bytes, at + 4);
        scale[2] = this.f32(bytes, at + 8);
        at += 12;
      }
      sink.row(entity, flags);
    }
  }
}

/** The largest finite `f32`. */
const F32_MAX = 3.4028234663852886e38;

/**
 * A scale lane as it goes on the wire: always a finite `f32`, so the decoder,
 * which refuses a non-finite scale, never refuses a frame this side wrote.
 *
 * @param value - The source's scale lane.
 * @returns The value clamped to the `f32` range, or 1 when it is not finite.
 */
function finiteOr1(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return value > F32_MAX ? F32_MAX : value < -F32_MAX ? -F32_MAX : value;
}
