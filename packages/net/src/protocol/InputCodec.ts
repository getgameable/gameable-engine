/**
 * `InputCodec` — one step of one player's input, client to server.
 *
 * Layout, little-endian, {@link INPUT_FRAME_BYTES} bytes:
 *
 * | Offset | Type             | Field                                        |
 * | ------ | ---------------- | -------------------------------------------- |
 * | 0      | u8               | kind = 1                                     |
 * | 1      | u32              | seq                                          |
 * | 5      | u32 x KEY_WORDS  | down                                         |
 * | 37     | u32 x KEY_WORDS  | pressed                                      |
 * | 69     | u32 x KEY_WORDS  | released                                     |
 * | 101    | u8               | mods: shift 1, ctrl 2, alt 4, meta 8, capsLock 16, numLock 32 |
 * | 102    | i16              | mouse dx                                     |
 * | 104    | i16              | mouse dy                                     |
 * | 106    | i8               | wheel                                        |
 * | 107    | u8               | buttons                                      |
 * | 108    | u8               | buttons pressed                              |
 * | 109    | u8               | buttons released                             |
 * | 110    | u8               | focused (non-zero is true)                   |
 */
import { KEY_WORDS } from '@gameable/sdk/keycodes';

import { FrameKind, INPUT_FRAME_BYTES } from './constants.js';
import { FrameCodec } from './FrameCodec.js';
import type { InputHeader, InputSnapshotLike, MutableInputSnapshot } from './types.js';

const KEYS_AT = 5;
const MODS_AT = KEYS_AT + 3 * 4 * KEY_WORDS;

/**
 * Encodes and decodes input frames. Owns the one header object `decode`
 * returns, so a decode allocates nothing.
 *
 * @example
 * ```ts
 * const keys = () => new Uint32Array(KEY_WORDS);
 * const snapshot: MutableInputSnapshot = {
 *   down: keys(), pressed: keys(), released: keys(),
 *   mods: { shift: false, ctrl: false, alt: false, meta: false, capsLock: false, numLock: false },
 *   mouse: { dx: -12, dy: 0, wheel: 0, buttons: 0, pressed: 0, released: 0 },
 *   focused: true,
 * };
 * const codec = new InputCodec();
 * const out = new DataView(new ArrayBuffer(INPUT_FRAME_BYTES));
 * const bytes = codec.encode(out, 1, snapshot);
 * const header = codec.decode(new Uint8Array(out.buffer, 0, bytes), snapshot); // { seq: 1 }
 * ```
 */
export class InputCodec extends FrameCodec {
  private readonly header: InputHeader = { seq: 0 };

  /**
   * Writes one input frame at the start of `out`.
   *
   * @param out - The send buffer, owned by the caller.
   * @param seq - The input sequence number; acks name it.
   * @param snapshot - The step's input.
   * @returns Bytes written, or 0 (with nothing written) when `out` is too small.
   */
  encode(out: DataView, seq: number, snapshot: InputSnapshotLike): number {
    if (out.byteLength < INPUT_FRAME_BYTES) return 0;
    out.setUint8(0, FrameKind.INPUT);
    out.setUint32(1, seq >>> 0, true);
    let at = KEYS_AT;
    at = writeKeys(out, at, snapshot.down);
    at = writeKeys(out, at, snapshot.pressed);
    writeKeys(out, at, snapshot.released);
    const { mods, mouse } = snapshot;
    out.setUint8(
      MODS_AT,
      (mods.shift ? 1 : 0) |
        (mods.ctrl ? 2 : 0) |
        (mods.alt ? 4 : 0) |
        (mods.meta ? 8 : 0) |
        (mods.capsLock ? 16 : 0) |
        (mods.numLock ? 32 : 0),
    );
    out.setInt16(MODS_AT + 1, this.clampInt(mouse.dx, -0x8000, 0x7fff), true);
    out.setInt16(MODS_AT + 3, this.clampInt(mouse.dy, -0x8000, 0x7fff), true);
    out.setInt8(MODS_AT + 5, this.clampInt(mouse.wheel, -0x80, 0x7f));
    out.setUint8(MODS_AT + 6, mouse.buttons & 0xff);
    out.setUint8(MODS_AT + 7, mouse.pressed & 0xff);
    out.setUint8(MODS_AT + 8, mouse.released & 0xff);
    out.setUint8(MODS_AT + 9, snapshot.focused ? 1 : 0);
    return INPUT_FRAME_BYTES;
  }

  /**
   * Reads one input frame into `into`.
   *
   * @param bytes - Exactly one received frame.
   * @param into - The caller's record, written only when the frame is good.
   * @returns The frame's `seq` in an object reused by the next call, or null
   * (with `into` untouched) when `bytes` is not exactly one input frame or a
   * key array of `into` is shorter than `KEY_WORDS`.
   */
  decode(bytes: Uint8Array, into: MutableInputSnapshot): InputHeader | null {
    if (!this.isKind(bytes, FrameKind.INPUT, INPUT_FRAME_BYTES)) return null;
    if (
      into.down.length < KEY_WORDS ||
      into.pressed.length < KEY_WORDS ||
      into.released.length < KEY_WORDS
    ) {
      return null;
    }
    for (let i = 0; i < KEY_WORDS; i += 1) {
      into.down[i] = this.u32(bytes, KEYS_AT + 4 * i);
      into.pressed[i] = this.u32(bytes, KEYS_AT + 4 * (KEY_WORDS + i));
      into.released[i] = this.u32(bytes, KEYS_AT + 4 * (2 * KEY_WORDS + i));
    }
    const bits = this.u8(bytes, MODS_AT);
    const { mods, mouse } = into;
    mods.shift = (bits & 1) !== 0;
    mods.ctrl = (bits & 2) !== 0;
    mods.alt = (bits & 4) !== 0;
    mods.meta = (bits & 8) !== 0;
    mods.capsLock = (bits & 16) !== 0;
    mods.numLock = (bits & 32) !== 0;
    mouse.dx = this.i16(bytes, MODS_AT + 1);
    mouse.dy = this.i16(bytes, MODS_AT + 3);
    mouse.wheel = this.i8(bytes, MODS_AT + 5);
    mouse.buttons = this.u8(bytes, MODS_AT + 6);
    mouse.pressed = this.u8(bytes, MODS_AT + 7);
    mouse.released = this.u8(bytes, MODS_AT + 8);
    into.focused = this.u8(bytes, MODS_AT + 9) !== 0;
    this.header.seq = this.u32(bytes, 1);
    return this.header;
  }
}

/**
 * Writes `KEY_WORDS` words of a key set; missing words are written as 0.
 *
 * @param out - The send buffer.
 * @param at - The first word's offset.
 * @param keys - The key set.
 * @returns The offset after the last word.
 */
function writeKeys(out: DataView, at: number, keys: Uint32Array): number {
  for (let i = 0; i < KEY_WORDS; i += 1) out.setUint32(at + 4 * i, keys[i], true);
  return at + 4 * KEY_WORDS;
}

/**
 * A new input codec with its own reusable header.
 *
 * @returns The codec.
 *
 * @example
 * ```ts
 * const codec = createInputCodec();
 * ```
 */
export function createInputCodec(): InputCodec {
  return new InputCodec();
}

const shared = new InputCodec();

/**
 * Writes one input frame at the start of `out`; see {@link InputCodec.encode}.
 *
 * @param out - The send buffer, owned by the caller.
 * @param seq - The input sequence number.
 * @param snapshot - The step's input.
 * @returns Bytes written, or 0 when `out` is too small.
 *
 * @example
 * ```ts
 * const keys = () => new Uint32Array(KEY_WORDS);
 * const snapshot: MutableInputSnapshot = {
 *   down: keys(), pressed: keys(), released: keys(),
 *   mods: { shift: false, ctrl: false, alt: false, meta: false, capsLock: false, numLock: false },
 *   mouse: { dx: -12, dy: 0, wheel: 0, buttons: 0, pressed: 0, released: 0 },
 *   focused: true,
 * };
 * const out = new DataView(new ArrayBuffer(INPUT_FRAME_BYTES));
 * const frame = new Uint8Array(out.buffer, 0, encodeInput(out, 1, snapshot)); // 111 bytes to send
 * ```
 */
export function encodeInput(out: DataView, seq: number, snapshot: InputSnapshotLike): number {
  return shared.encode(out, seq, snapshot);
}

/**
 * Reads one input frame into `into`; see {@link InputCodec.decode}. The
 * returned object is shared by every call: read `seq` before the next decode.
 *
 * @param bytes - Exactly one received frame.
 * @param into - The caller's record.
 * @returns `{ seq }`, or null for a malformed frame.
 *
 * @example
 * ```ts
 * const keys = () => new Uint32Array(KEY_WORDS);
 * const snapshot: MutableInputSnapshot = {
 *   down: keys(), pressed: keys(), released: keys(),
 *   mods: { shift: false, ctrl: false, alt: false, meta: false, capsLock: false, numLock: false },
 *   mouse: { dx: -12, dy: 0, wheel: 0, buttons: 0, pressed: 0, released: 0 },
 *   focused: true,
 * };
 * const out = new DataView(new ArrayBuffer(INPUT_FRAME_BYTES));
 * const message = new Uint8Array(out.buffer, 0, encodeInput(out, 42, snapshot));
 * const lastSeq = decodeInput(message, snapshot)?.seq; // 42
 * ```
 */
export function decodeInput(bytes: Uint8Array, into: MutableInputSnapshot): InputHeader | null {
  return shared.decode(bytes, into);
}
