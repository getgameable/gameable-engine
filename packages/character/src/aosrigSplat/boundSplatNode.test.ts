/**
 * The record split the TSL deformation reads: floats stay floats, and every lane the WGSL
 * reads as integer bits moves into the integer half unchanged. A lane left behind would reach
 * the GPU as a denormal float, which a WebGL texture read may flush to zero.
 */
import { describe, expect, it } from 'vitest';

import { BOUND_FLOAT_VEC4S, BOUND_UINT_VEC4S, splitBoundRecords } from './boundSplatNode.js';

describe('splitBoundRecords', () => {
  it('moves the integer lanes bit-exact and keeps the floats in place', () => {
    const records = new Float32Array(44 * 2);
    const bits = new Uint32Array(records.buffer);
    for (let n = 0; n < 2; n++) {
      const r = n * 44;
      for (let k = 0; k < 16; k++) records[r + k] = n * 100 + k + 0.5; // center, covA, covB, color
      bits.set([3, 17, 42, 127], r + 16); // joints
      records.set([0.4, 0.3, 0.2, 0.1], r + 20); // weights
      bits.set([1000 + n, 2000, 3000], r + 24); // face vertices
      records[r + 27] = 0.75; // the face blend, a float in an integer lane
      records.set([1, 2, 3], r + 28);
      bits[r + 31] = 3; // hidden kind
      records.set([4, 5, 6], r + 32);
      bits[r + 35] = 11; // upper lip vertex
      records.set([7, 8, 9], r + 36);
      bits[r + 39] = 12; // lower lip vertex
      records.set([-1, -2, -3], r + 40);
      bits[r + 43] = 5; // band index
    }

    const { floats, uints } = splitBoundRecords(records, 2);

    expect(floats).toHaveLength(2 * BOUND_FLOAT_VEC4S * 4);
    expect(uints).toHaveLength(2 * BOUND_UINT_VEC4S * 4);
    const f = BOUND_FLOAT_VEC4S * 4,
      u = BOUND_UINT_VEC4S * 4;
    expect(Array.from(floats.subarray(f, f + 16))).toEqual(
      Array.from({ length: 16 }, (_, k) => 100 + k + 0.5),
    );
    expect(Array.from(floats.subarray(f + 16, f + 20))).toEqual(
      Array.from(new Float32Array([0.4, 0.3, 0.2, 0.1])),
    );
    expect(Array.from(floats.subarray(f + 20, f + 36))).toEqual([
      1, 2, 3, 0.75, 4, 5, 6, 0, 7, 8, 9, 0, -1, -2, -3, 0,
    ]);
    expect(Array.from(uints.subarray(u, u + 12))).toEqual([
      3, 17, 42, 127, 1001, 2000, 3000, 3, 11, 12, 5, 0,
    ]);
  });

  it('writes at an offset into a shared output', () => {
    const records = new Float32Array(44);
    new Uint32Array(records.buffer)[16] = 9;
    const out = {
      floats: new Float32Array(3 * BOUND_FLOAT_VEC4S * 4),
      uints: new Uint32Array(3 * BOUND_UINT_VEC4S * 4),
    };
    splitBoundRecords(records, 1, out, 2);
    expect(out.uints[2 * BOUND_UINT_VEC4S * 4]).toBe(9);
    expect(out.uints[0]).toBe(0);
  });
});
