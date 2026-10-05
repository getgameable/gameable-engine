/**
 * `PlayerTrailer` — the optional tail of a rows frame: the receiving
 * player's own body, for client-side prediction (Task 8.1).
 *
 * Layout, little-endian, right after the last row:
 *
 * | Offset | Type     | Field                          |
 * | ------ | -------- | ------------------------------ |
 * | 0      | u8       | tag = `PLAYER_TRAILER_TAG` (1) |
 * | 1      | u32      | entity                         |
 * | 5      | u32      | seq (the frame's `ack`)        |
 * | 9      | 3 x f32  | position, metres               |
 * | 21     | 3 x f32  | velocity, metres per second    |
 * | 33     | u8       | `PlayerRowFlag` bits           |
 *
 * Positions are exact `f32`, not millimetres: a predicting client compares
 * them with its own body to 2 cm and replays from them, so rounding would
 * be an error it never made. A frame without the trailer is the old frame
 * byte for byte, so a client that does not predict ignores it.
 */
import { PLAYER_ROW_FLAG_MASK, PLAYER_TRAILER_BYTES, PLAYER_TRAILER_TAG } from './constants.js';
import { FrameCodec } from './FrameCodec.js';
import type { PlayerRow, PlayerRowSource } from './types.js';

/** Reads and writes the trailer; owns the one `PlayerRow` decodes fill. */
export class PlayerTrailer extends FrameCodec {
  /** The decoded trailer, rewritten by every {@link PlayerTrailer.read}. */
  readonly row: PlayerRow = {
    entity: 0,
    seq: 0,
    position: new Float32Array(3),
    velocity: new Float32Array(3),
    flags: 0,
  };

  /**
   * @param out The send buffer, already checked to hold the trailer at `at`.
   * @param at Where the trailer starts.
   * @param seq The frame's ack.
   * @param source The player's body; a non-finite lane is written as 0.
   */
  write(out: DataView, at: number, seq: number, source: PlayerRowSource): void {
    out.setUint8(at, PLAYER_TRAILER_TAG);
    out.setUint32(at + 1, source.entity >>> 0, true);
    out.setUint32(at + 5, seq >>> 0, true);
    const p = source.position;
    const v = source.velocity;
    for (let i = 0; i < 3; i += 1) {
      out.setFloat32(at + 9 + i * 4, finiteOr0(p[i]), true);
      out.setFloat32(at + 21 + i * 4, finiteOr0(v[i]), true);
    }
    out.setUint8(at + 33, source.flags & PLAYER_ROW_FLAG_MASK);
  }

  /**
   * @param bytes The frame.
   * @param at Where the trailer would start (just past the last row).
   * @returns True when exactly one well-formed trailer fills the rest of the frame.
   */
  check(bytes: Uint8Array, at: number): boolean {
    if (at + PLAYER_TRAILER_BYTES !== bytes.length) return false;
    if (this.u8(bytes, at) !== PLAYER_TRAILER_TAG) return false;
    if ((this.u8(bytes, at + 33) & ~PLAYER_ROW_FLAG_MASK) !== 0) return false;
    for (let lane = 0; lane < 6; lane += 1) {
      if (!Number.isFinite(this.f32(bytes, at + 9 + lane * 4))) return false;
    }
    return true;
  }

  /**
   * @param bytes A frame whose trailer {@link PlayerTrailer.check} accepted.
   * @param at Where the trailer starts.
   * @returns The trailer row (`PlayerTrailer.row`), filled.
   */
  read(bytes: Uint8Array, at: number): PlayerRow {
    const row = this.row;
    row.entity = this.u32(bytes, at + 1);
    row.seq = this.u32(bytes, at + 5);
    for (let i = 0; i < 3; i += 1) {
      row.position[i] = this.f32(bytes, at + 9 + i * 4);
      row.velocity[i] = this.f32(bytes, at + 21 + i * 4);
    }
    row.flags = this.u8(bytes, at + 33);
    return row;
  }
}

/** The largest finite `f32`. */
const F32_MAX = 3.4028234663852886e38;

/**
 * @param value A source lane.
 * @returns It clamped to the `f32` range, or 0 when it is not finite.
 */
function finiteOr0(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return value > F32_MAX ? F32_MAX : value < -F32_MAX ? -F32_MAX : value;
}
