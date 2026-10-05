import { KEY_WORDS } from '@gameable/sdk/keycodes';
import { describe, expect, it } from 'vitest';

import { FrameKind, INPUT_FRAME_BYTES } from './constants.js';
import { decodeInput, encodeInput } from './InputCodec.js';
import type { InputSnapshotLike, MutableInputSnapshot } from './types.js';

function blank(): MutableInputSnapshot {
  return {
    down: new Uint32Array(KEY_WORDS),
    pressed: new Uint32Array(KEY_WORDS),
    released: new Uint32Array(KEY_WORDS),
    mods: { shift: false, ctrl: false, alt: false, meta: false, capsLock: false, numLock: false },
    mouse: { dx: 0, dy: 0, wheel: 0, buttons: 0, pressed: 0, released: 0 },
    focused: false,
  };
}

function sample(): InputSnapshotLike {
  const s = blank();
  s.down.fill(0xffffffff);
  for (let i = 0; i < KEY_WORDS; i += 1) {
    s.pressed[i] = (0x80000001 + i) >>> 0;
    s.released[i] = (0x12345678 * (i + 1)) >>> 0;
  }
  Object.assign(s.mods, { shift: true, ctrl: false, alt: true, meta: true, numLock: true });
  Object.assign(s.mouse, { dx: -120, dy: 37, wheel: -3, buttons: 5, pressed: 4, released: 2 });
  s.focused = true;
  return s;
}

const buffer = new ArrayBuffer(256);
const view = new DataView(buffer);

describe('encodeInput / decodeInput', () => {
  it('writes the documented frame size, little-endian, kind first', () => {
    const written = encodeInput(view, 0x01020304, sample());
    expect(written).toBe(INPUT_FRAME_BYTES);
    const bytes = new Uint8Array(buffer, 0, written);
    expect(bytes[0]).toBe(FrameKind.INPUT);
    expect(Array.from(bytes.subarray(1, 5))).toEqual([4, 3, 2, 1]);
  });

  it('round-trips every key bit, negative dx and a wheel of -3', () => {
    const source = sample();
    const written = encodeInput(view, 77, source);
    const into = blank();
    const header = decodeInput(new Uint8Array(buffer, 0, written), into);
    expect(header).toEqual({ seq: 77 });
    expect(Array.from(into.down)).toEqual(Array.from(source.down));
    expect(Array.from(into.pressed)).toEqual(Array.from(source.pressed));
    expect(Array.from(into.released)).toEqual(Array.from(source.released));
    expect(into.mods).toEqual({ ...source.mods, capsLock: false });
    expect(into.mouse).toEqual(source.mouse);
    expect(into.focused).toBe(true);
  });

  it('rounds and clamps the mouse to its wire widths', () => {
    const source = blank();
    Object.assign(source.mouse, { dx: 1e6, dy: -1e6, wheel: -999, buttons: 0x1ff });
    const into = blank();
    decodeInput(new Uint8Array(buffer, 0, encodeInput(view, 1, source)), into);
    expect(into.mouse).toMatchObject({ dx: 32767, dy: -32768, wheel: -128, buttons: 0xff });
  });

  it('returns 0 and writes nothing when the buffer is too small', () => {
    const small = new DataView(new ArrayBuffer(INPUT_FRAME_BYTES - 1));
    expect(encodeInput(small, 1, sample())).toBe(0);
    expect(new Uint8Array(small.buffer).every((b) => b === 0)).toBe(true);
  });

  it('returns null for a truncated frame, a long one and an unknown kind', () => {
    const written = encodeInput(view, 9, sample());
    const into = blank();
    expect(decodeInput(new Uint8Array(buffer, 0, written - 1), into)).toBeNull();
    expect(decodeInput(new Uint8Array(buffer, 0, written + 1), into)).toBeNull();
    expect(decodeInput(new Uint8Array(0), into)).toBeNull();
    const wrongKind = new Uint8Array(buffer.slice(0, written));
    wrongKind[0] = 7;
    expect(decodeInput(wrongKind, into)).toBeNull();
    wrongKind[0] = FrameKind.ROWS;
    expect(decodeInput(wrongKind, into)).toBeNull();
  });

  it('returns null rather than write into key arrays that are too short', () => {
    const written = encodeInput(view, 9, sample());
    const into = { ...blank(), down: new Uint32Array(KEY_WORDS - 1) };
    expect(decodeInput(new Uint8Array(buffer, 0, written), into)).toBeNull();
  });

  it('reads a frame that does not start at its buffer offset 0', () => {
    const written = encodeInput(new DataView(buffer, 3), 5, sample());
    const into = blank();
    expect(decodeInput(new Uint8Array(buffer, 3, written), into)?.seq).toBe(5);
  });
});
