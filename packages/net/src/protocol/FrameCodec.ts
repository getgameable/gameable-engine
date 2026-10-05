/**
 * `FrameCodec` — the shared base of the binary frame codecs.
 *
 * Decoders read little-endian straight out of the `Uint8Array` they are handed
 * instead of wrapping it in a `DataView`, so a decode allocates nothing even
 * though every WebSocket message arrives in a fresh buffer. The readers do no
 * bounds checks of their own: a subclass checks the frame's length first and
 * only reads offsets already known to be in range.
 */

/**
 * Little-endian reads over a byte array, and the frame-kind check every binary
 * frame starts with.
 *
 * @example
 * ```ts
 * class PingCodec extends FrameCodec {
 *   decode(bytes: Uint8Array): number | null {
 *     return this.isKind(bytes, 9, 5) ? this.u32(bytes, 1) : null;
 *   }
 * }
 * ```
 */
export abstract class FrameCodec {
  /** One scratch word, so a float is read without allocating and on any host byte order. */
  private readonly word = new DataView(new ArrayBuffer(4));

  /**
   * Whether `bytes` is a frame of `kind` and the right length.
   *
   * @param bytes - The received frame.
   * @param kind - The expected first byte.
   * @param length - The frame's length, or its least length when `exact` is false.
   * @param exact - Whether the length must match exactly.
   * @returns True when the length fits and the first byte is `kind`.
   */
  protected isKind(bytes: Uint8Array, kind: number, length: number, exact = true): boolean {
    if (exact ? bytes.length !== length : bytes.length < length) return false;
    return bytes[0] === kind;
  }

  /**
   * The unsigned byte at `offset`.
   *
   * @param bytes - The frame, already length-checked.
   * @param offset - An in-range offset.
   * @returns A value in `[0, 255]`.
   */
  protected u8(bytes: Uint8Array, offset: number): number {
    return bytes[offset];
  }

  /**
   * The signed byte at `offset`.
   *
   * @param bytes - The frame, already length-checked.
   * @param offset - An in-range offset.
   * @returns A value in `[-128, 127]`.
   */
  protected i8(bytes: Uint8Array, offset: number): number {
    return (bytes[offset] << 24) >> 24;
  }

  /**
   * The unsigned 16-bit integer at `offset`.
   *
   * @param bytes - The frame, already length-checked.
   * @param offset - An offset with two bytes in range.
   * @returns A value in `[0, 65535]`.
   */
  protected u16(bytes: Uint8Array, offset: number): number {
    return bytes[offset] | (bytes[offset + 1] << 8);
  }

  /**
   * The signed 16-bit integer at `offset`.
   *
   * @param bytes - The frame, already length-checked.
   * @param offset - An offset with two bytes in range.
   * @returns A value in `[-32768, 32767]`.
   */
  protected i16(bytes: Uint8Array, offset: number): number {
    return (this.u16(bytes, offset) << 16) >> 16;
  }

  /**
   * The signed 32-bit integer at `offset`.
   *
   * @param bytes - The frame, already length-checked.
   * @param offset - An offset with four bytes in range.
   * @returns A signed 32-bit value.
   */
  protected i32(bytes: Uint8Array, offset: number): number {
    return (
      bytes[offset] |
      (bytes[offset + 1] << 8) |
      (bytes[offset + 2] << 16) |
      (bytes[offset + 3] << 24)
    );
  }

  /**
   * The unsigned 32-bit integer at `offset`.
   *
   * @param bytes - The frame, already length-checked.
   * @param offset - An offset with four bytes in range.
   * @returns An unsigned 32-bit value.
   */
  protected u32(bytes: Uint8Array, offset: number): number {
    return this.i32(bytes, offset) >>> 0;
  }

  /**
   * The little-endian 32-bit float at `offset`.
   *
   * @param bytes - The frame, already length-checked.
   * @param offset - An offset with four bytes in range.
   * @returns The float, which may be NaN or infinite on a hostile frame.
   */
  protected f32(bytes: Uint8Array, offset: number): number {
    this.word.setUint32(0, this.u32(bytes, offset), true);
    return this.word.getFloat32(0, true);
  }

  /**
   * `value` rounded and clamped, for an integer wire field.
   *
   * @param value - Any number.
   * @param min - The least result.
   * @param max - The greatest result.
   * @returns The rounded value in `[min, max]`; 0 for a non-finite value.
   */
  protected clampInt(value: number, min: number, max: number): number {
    if (!Number.isFinite(value)) return 0;
    const rounded = Math.round(value);
    return rounded < min ? min : rounded > max ? max : rounded;
  }
}
