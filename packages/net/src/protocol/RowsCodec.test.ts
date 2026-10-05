import { describe, expect, it } from 'vitest';

import { FrameKind, RowFlag, ROWS_HEADER_BYTES } from './constants.js';
import { decodeRows, encodeRows, rowsFrameBytes } from './rowsFunctions.js';
import type { RowSink, RowSource } from './types.js';

interface Row {
  entity: number;
  flags: number;
  position: number[];
  rotation: number[];
  scale: number[];
}

function source(rows: Row[]): RowSource {
  return {
    count: rows.length,
    entity: (i) => rows[i].entity,
    flags: (i) => rows[i].flags,
    position: (i) => rows[i].position,
    rotation: (i) => rows[i].rotation,
    scale: (i) => rows[i].scale,
  };
}

// A sink that records what it was handed, NaN for lanes the row did not carry.
function recorder(): RowSink & { rows: Row[] } {
  const sink = {
    rows: [] as Row[],
    position: new Float32Array(3),
    rotation: new Float32Array(4),
    scale: new Float32Array(3),
    row(entity: number, flags: number) {
      sink.rows.push({
        entity,
        flags,
        position: Array.from(sink.position),
        rotation: Array.from(sink.rotation),
        scale: Array.from(sink.scale),
      });
      sink.position.fill(Number.NaN);
      sink.rotation.fill(Number.NaN);
      sink.scale.fill(Number.NaN);
    },
  };
  sink.position.fill(Number.NaN);
  sink.rotation.fill(Number.NaN);
  sink.scale.fill(Number.NaN);
  return sink;
}

const ALL = RowFlag.POSITION | RowFlag.ROTATION | RowFlag.SCALE;
const half = Math.SQRT1_2;
const rows: Row[] = [
  {
    entity: 1,
    flags: ALL,
    position: [1.2344, -0.0006, 99.9996],
    rotation: [0, 0, half, half],
    scale: [1, 2, 0.5],
  },
  { entity: 0xfffffffe, flags: RowFlag.POSITION, position: [-3, 4.5, 0], rotation: [], scale: [] },
  { entity: 42, flags: RowFlag.ROTATION, position: [], rotation: [0.5, -0.5, 0.5, 0.5], scale: [] },
  { entity: 7, flags: 0, position: [], rotation: [], scale: [] },
];

const buffer = new ArrayBuffer(1024);
const view = new DataView(buffer);

describe('encodeRows / decodeRows', () => {
  it('round-trips positions within 0.5 mm and rotations within 1e-3', () => {
    const written = encodeRows(view, 1000, 77, source(rows));
    expect(written).toBe(rowsFrameBytes(source(rows)));
    const sink = recorder();
    expect(decodeRows(new Uint8Array(buffer, 0, written), sink)).toEqual({
      frame: 1000,
      ack: 77,
      count: 4,
      player: null,
    });
    expect(sink.rows.map((r) => [r.entity, r.flags])).toEqual(rows.map((r) => [r.entity, r.flags]));
    const [a, b, c, d] = sink.rows;
    for (let i = 0; i < 3; i += 1) {
      expect(Math.abs(a.position[i] - rows[0].position[i])).toBeLessThanOrEqual(0.0005 + 1e-6);
      expect(a.scale[i]).toBe(rows[0].scale[i]);
      expect(Math.abs(b.position[i] - rows[1].position[i])).toBeLessThanOrEqual(0.0005 + 1e-6);
    }
    for (let i = 0; i < 4; i += 1) {
      expect(Math.abs(a.rotation[i] - rows[0].rotation[i])).toBeLessThan(1e-3);
      expect(Math.abs(c.rotation[i] - rows[2].rotation[i])).toBeLessThan(1e-3);
    }
    // Lanes a row does not carry are left alone.
    expect(b.rotation.every(Number.isNaN)).toBe(true);
    expect(c.position.every(Number.isNaN)).toBe(true);
    expect([...d.position, ...d.rotation, ...d.scale].every(Number.isNaN)).toBe(true);
  });

  it('sends scale exactly: a mirrored -1, a sky dome 100 and a half both survive', () => {
    const scaled = [
      { entity: 3, flags: RowFlag.SCALE, position: [], rotation: [], scale: [-1, 100, 0.5] },
    ];
    const written = encodeRows(view, 1, 1, source(scaled));
    expect(written).toBe(ROWS_HEADER_BYTES + 5 + 12);
    const sink = recorder();
    expect(decodeRows(new Uint8Array(buffer, 0, written), sink)?.count).toBe(1);
    expect(sink.rows[0].scale).toEqual([-1, 100, 0.5]);
  });

  it('writes a non-finite scale as 1 and a huge one as the largest f32, so its own frames decode', () => {
    const scaled = [
      {
        entity: 3,
        flags: RowFlag.SCALE,
        position: [],
        rotation: [],
        scale: [Number.NaN, 1e39, -1e39],
      },
    ];
    const written = encodeRows(view, 1, 1, source(scaled));
    const sink = recorder();
    expect(decodeRows(new Uint8Array(buffer, 0, written), sink)?.count).toBe(1);
    expect(sink.rows[0].scale).toEqual([1, 3.4028234663852886e38, -3.4028234663852886e38]);
  });

  it('returns null for a frame whose scale lane is NaN or infinite', () => {
    const scaled = [
      { entity: 3, flags: RowFlag.SCALE, position: [], rotation: [], scale: [1, 1, 1] },
    ];
    const written = encodeRows(view, 1, 1, source(scaled));
    const sink = recorder();
    for (const bad of [Number.NaN, Infinity, -Infinity]) {
      const bytes = new Uint8Array(buffer.slice(0, written));
      new DataView(bytes.buffer).setFloat32(ROWS_HEADER_BYTES + 5 + 4, bad, true);
      expect(decodeRows(bytes, sink)).toBeNull();
    }
    expect(sink.rows).toEqual([]);
  });

  it('returns 0 for a row count that is not a non-negative integer', () => {
    for (const count of [-1, 1.5, Number.NaN]) {
      expect(encodeRows(view, 1, 1, { ...source(rows), count })).toBe(0);
    }
  });

  it('writes the header only for zero rows', () => {
    const written = encodeRows(view, 3, 2, source([]));
    expect(written).toBe(ROWS_HEADER_BYTES);
    const bytes = new Uint8Array(buffer, 0, written);
    expect(Array.from(bytes)).toEqual([FrameKind.ROWS, 3, 0, 0, 0, 2, 0, 0, 0, 0, 0]);
    expect(decodeRows(bytes, recorder())).toEqual({ frame: 3, ack: 2, count: 0, player: null });
  });

  it('returns 0 when the frame would not fit', () => {
    const needed = rowsFrameBytes(source(rows));
    expect(encodeRows(new DataView(buffer, 0, needed - 1), 1, 1, source(rows))).toBe(0);
  });

  it('returns null when count claims more rows than the buffer holds', () => {
    const written = encodeRows(view, 1, 1, source(rows));
    const bytes = new Uint8Array(buffer.slice(0, written));
    bytes[9] = 5; // count, low byte: one more row than was written
    const sink = recorder();
    expect(decodeRows(bytes, sink)).toBeNull();
    bytes[9] = 0xff;
    bytes[10] = 0xff;
    expect(decodeRows(bytes, sink)).toBeNull();
    expect(sink.rows).toEqual([]); // nothing reached the sink from a bad frame
  });

  it('returns null for a truncated frame, trailing bytes, unknown kind or unknown flags', () => {
    const written = encodeRows(view, 1, 1, source(rows));
    const sink = recorder();
    expect(decodeRows(new Uint8Array(buffer, 0, written - 1), sink)).toBeNull();
    expect(decodeRows(new Uint8Array(buffer, 0, written + 1), sink)).toBeNull();
    expect(decodeRows(new Uint8Array(buffer, 0, ROWS_HEADER_BYTES - 1), sink)).toBeNull();
    const bytes = new Uint8Array(buffer.slice(0, written));
    bytes[0] = FrameKind.INPUT;
    expect(decodeRows(bytes, sink)).toBeNull();
    bytes[0] = FrameKind.ROWS;
    bytes[ROWS_HEADER_BYTES + 4] = 0x40; // the first row's flags, an unknown bit
    expect(decodeRows(bytes, sink)).toBeNull();
    expect(sink.rows).toEqual([]);
  });

  it('carries VISIBLE and TELEPORT as lane-free bits, the same values as TRANSFORM_FLAGS', () => {
    expect(RowFlag.VISIBLE).toBe(8);
    expect(RowFlag.TELEPORT).toBe(16);
    const snapped = [
      {
        entity: 9,
        flags: RowFlag.POSITION | RowFlag.TELEPORT | RowFlag.VISIBLE,
        position: [1, 2, 3],
        rotation: [],
        scale: [],
      },
      { entity: 10, flags: RowFlag.VISIBLE, position: [], rotation: [], scale: [] },
    ];
    const written = encodeRows(view, 5, 6, source(snapped));
    // Header, then 5 + 12 bytes and 5 bytes: the two bits add no lanes.
    expect(written).toBe(ROWS_HEADER_BYTES + 17 + 5);
    const sink = recorder();
    expect(decodeRows(new Uint8Array(buffer, 0, written), sink)?.count).toBe(2);
    expect(sink.rows.map((r) => [r.entity, r.flags])).toEqual([
      [9, RowFlag.POSITION | RowFlag.TELEPORT | RowFlag.VISIBLE],
      [10, RowFlag.VISIBLE],
    ]);
  });

  it('returns null rather than write into sink arrays that are too short', () => {
    const written = encodeRows(view, 1, 1, source(rows));
    const sink = { ...recorder(), rotation: new Float32Array(3) };
    expect(decodeRows(new Uint8Array(buffer, 0, written), sink)).toBeNull();
  });
});
