import { KEY_WORDS } from '@gameable/sdk/keycodes';
import { describe, expect, it } from 'vitest';

import { FrameKind, INPUT_FRAME_BYTES, ROWS_HEADER_BYTES } from './constants.js';
import { decodeInput } from './InputCodec.js';
import { decodeRows } from './rowsFunctions.js';
import type { MutableInputSnapshot, RowSink } from './types.js';

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('decoders on hostile bytes', () => {
  it('1,000 random buffers of 0-64 bytes never throw, and nothing shorter than a header decodes', () => {
    const random = mulberry32(3_3);
    const into: MutableInputSnapshot = {
      down: new Uint32Array(KEY_WORDS),
      pressed: new Uint32Array(KEY_WORDS),
      released: new Uint32Array(KEY_WORDS),
      mods: { shift: false, ctrl: false, alt: false, meta: false, capsLock: false, numLock: false },
      mouse: { dx: 0, dy: 0, wheel: 0, buttons: 0, pressed: 0, released: 0 },
      focused: false,
    };
    const sink: RowSink = {
      position: new Float32Array(3),
      rotation: new Float32Array(4),
      scale: new Float32Array(3),
      row: () => undefined,
    };
    for (let n = 0; n < 1000; n += 1) {
      const length = Math.floor(random() * 65);
      const bytes = new Uint8Array(length);
      for (let i = 0; i < length; i += 1) bytes[i] = Math.floor(random() * 256);
      // Half the buffers start with a real kind byte, so the decoders get past the first check.
      if (length > 0 && n % 2 === 0) bytes[0] = n % 4 === 0 ? FrameKind.INPUT : FrameKind.ROWS;
      const input = decodeInput(bytes, into);
      const rows = decodeRows(bytes, sink);
      if (length < INPUT_FRAME_BYTES) expect(input).toBeNull();
      if (length < ROWS_HEADER_BYTES) expect(rows).toBeNull();
      if (rows) expect(ROWS_HEADER_BYTES + rows.count * 5).toBeLessThanOrEqual(length);
    }
  });

  it('a decoded rows frame only ever hands the sink finite lanes', () => {
    const random = mulberry32(91);
    const lanes: number[] = [];
    let refused = 0;
    const sink: RowSink = {
      position: new Float32Array(3),
      rotation: new Float32Array(4),
      scale: new Float32Array(3),
      row: () => lanes.push(...sink.position, ...sink.rotation, ...sink.scale),
    };
    for (let n = 0; n < 1000; n += 1) {
      // A plausible header with one row of every lane and random contents.
      const bytes = new Uint8Array(ROWS_HEADER_BYTES + 33);
      for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(random() * 256);
      bytes[0] = FrameKind.ROWS;
      bytes[9] = 1;
      bytes[10] = 0;
      bytes[ROWS_HEADER_BYTES + 4] = 7;
      // Random scale bits can be NaN or infinite: that frame is refused, any other decodes.
      const header = decodeRows(bytes, sink);
      if (header === null) refused += 1;
      else expect(header.count).toBe(1);
    }
    expect(lanes.every(Number.isFinite)).toBe(true);
    expect(refused).toBeLessThan(100);
  });
});
