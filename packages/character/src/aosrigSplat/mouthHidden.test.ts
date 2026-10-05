// The closed mouth's inside points as data: the file, the fade with the lips' gap, the plugs'
// push, and the lanes a chunk carries.

import { describe, expect, it } from 'vitest';

import {
  BAND_CAP_M,
  HIDDEN_LANE,
  HIDE_GAP_M,
  bandShapes,
  hiddenAlpha,
  hiddenLanes,
  parseMouthHidden,
  plugPush,
} from './mouthHidden.js';

/** A list of `entries` (row, kind, upper, lower) with the head's up +y and forward +z. */
function file(entries: number[][], up = [0, 1, 0], forward = [0, 0, 1]): Uint8Array {
  const out = new Uint8Array(36 + entries.length * 16);
  out.set(new TextEncoder().encode('AOSMHD01'));
  const v = new DataView(out.buffer);
  v.setUint32(8, entries.length, true);
  [...up, ...forward].forEach((x, i) => {
    v.setFloat32(12 + i * 4, x, true);
  });
  entries.forEach((e, i) => {
    e.forEach((x, k) => {
      v.setUint32(36 + i * 16 + k * 4, x, true);
    });
  });
  return out;
}

describe('mouth_hidden.bin', () => {
  it('reads the axes, the rows, the kinds and the lip vertices', () => {
    const h = parseMouthHidden(
      file(
        [
          [7, 1, 10, 11],
          [3, 2, 12, 13],
          [9, 3, 12, 13],
        ],
        [0, 2, 0],
      ),
      20,
      14,
    );
    expect(h.count).toBe(3);
    expect(h.plugs).toBe(1);
    expect(h.band).toBe(1);
    expect([...h.up]).toEqual([0, 1, 0]);
    expect([...h.forward]).toEqual([0, 0, 1]);
    expect([...h.row]).toEqual([7, 3, 9]);
    expect([...h.kind]).toEqual([1, 2, 3]);
    expect([...h.upper]).toEqual([10, 12, 12]);
    expect([...h.lower]).toEqual([11, 13, 13]);
  });

  it('refuses a bad magic, size, row, kind, vertex, a row twice, an axis that is no direction', () => {
    const good = [[7, 1, 10, 11]];
    expect(() => parseMouthHidden(file(good).slice(0, -1), 20, 14)).toThrow(/size/);
    const bad = file(good);
    bad[0] = 0x58;
    expect(() => parseMouthHidden(bad, 20, 14)).toThrow(/not a hidden/);
    expect(() => parseMouthHidden(file([[20, 1, 10, 11]]), 20, 14)).toThrow(/splat/);
    expect(() => parseMouthHidden(file([[7, 4, 10, 11]]), 20, 14)).toThrow(/kind/);
    expect(() => parseMouthHidden(file([[7, 1, 14, 11]]), 20, 14)).toThrow(/vertex/);
    expect(() =>
      parseMouthHidden(
        file([
          [7, 1, 10, 11],
          [7, 2, 10, 11],
        ]),
        20,
        14,
      ),
    ).toThrow(/twice/);
    expect(() => parseMouthHidden(file(good, [0, 0, 0]), 20, 14)).toThrow(/direction/);
  });

  it('keeps a listed splat whole while the lips touch and takes it away by 2 mm', () => {
    expect(hiddenAlpha(0)).toBe(1);
    expect(hiddenAlpha(HIDE_GAP_M[0])).toBe(1);
    expect(hiddenAlpha((HIDE_GAP_M[0] + HIDE_GAP_M[1]) / 2)).toBeCloseTo(0.5, 9);
    expect(hiddenAlpha(HIDE_GAP_M[1])).toBe(0);
    expect(hiddenAlpha(0.02)).toBe(0);
    expect(HIDE_GAP_M[1]).toBe(0.002);
    expect(BAND_CAP_M).toBe(0.0025);
  });

  it('pushes a plug back more the wider the lips part, 3 mm plus a quarter of the gap', () => {
    expect(plugPush(0)).toBe(0);
    expect(plugPush(0.001)).toBeCloseTo(0.0015 + 0.00025, 9);
    expect(plugPush(0.002)).toBeCloseTo(0.003 + 0.0005, 9);
    expect(plugPush(0.03)).toBeCloseTo(0.003 + 0.0075, 9);
    expect(plugPush(0.1)).toBeCloseTo(0.003 + 0.0075, 9);
  });

  it('writes each listed row of a chunk its kind and lip vertices, as integer bits, and nothing else', () => {
    const h = parseMouthHidden(
      file([
        [5, 1, 10, 11],
        [1, 2, 12, 13],
      ]),
      20,
      14,
    );
    const records = new Float32Array(3 * 44);
    hiddenLanes(records, 4, 3, h); // rows 4, 5, 6: only row 5 is listed
    const u = new Uint32Array(records.buffer);
    expect([
      u[44 + HIDDEN_LANE.kind],
      u[44 + HIDDEN_LANE.upper],
      u[44 + HIDDEN_LANE.lower],
    ]).toEqual([1, 10, 11]);
    expect([u[HIDDEN_LANE.kind], u[2 * 44 + HIDDEN_LANE.kind]]).toEqual([0, 0]);
    hiddenLanes(records, 0, 3, h); // rows 0, 1, 2: row 1
    expect([u[44 + HIDDEN_LANE.kind], u[44 + HIDDEN_LANE.upper]]).toEqual([2, 12]);
    const none = new Float32Array(44);
    hiddenLanes(none, 0, 1, null);
    expect(none[HIDDEN_LANE.kind]).toBe(0);
  });

  it("numbers the band splats in the list's order and gathers their own turn and sizes", () => {
    const h = parseMouthHidden(
      file([
        [5, 3, 10, 11],
        [1, 2, 12, 13],
        [2, 3, 12, 13],
      ]),
      20,
      14,
    );
    const records = new Float32Array(6 * 44);
    hiddenLanes(records, 0, 6, h);
    const u = new Uint32Array(records.buffer);
    expect([
      u[5 * 44 + HIDDEN_LANE.band],
      u[1 * 44 + HIDDEN_LANE.band],
      u[2 * 44 + HIDDEN_LANE.band],
    ]).toEqual([1, 0, 2]);
    const shapes = bandShapes(
      h,
      (row, out) => {
        out.set([2 * row, 0, 0, 0]);
      },
      (row, out) => {
        out.set([0.001 * row, 0.002, 0.003]);
      },
    );
    expect(shapes.length).toBe(16);
    expect([...shapes.subarray(0, 4)]).toEqual([1, 0, 0, 0]);
    expect(shapes[4]).toBeCloseTo(0.005, 7);
    expect(shapes[5]).toBeCloseTo(0.002, 7);
    expect(shapes[6]).toBeCloseTo(0.003, 7);
    expect(shapes[7]).toBe(0);
    expect([...shapes.subarray(8, 12)]).toEqual([1, 0, 0, 0]);
    expect(shapes[12]).toBeCloseTo(0.002, 7);
    // no band: one row of zeros, so the buffer is never empty
    const noBand = parseMouthHidden(file([[5, 2, 10, 11]]), 20, 14);
    expect(
      bandShapes(
        noBand,
        () => undefined,
        () => undefined,
      ).length,
    ).toBe(8);
  });
});
