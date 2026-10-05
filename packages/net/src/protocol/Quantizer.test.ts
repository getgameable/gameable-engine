import { describe, expect, it } from 'vitest';

import { packQuat, Quantizer, unpackQuat } from './Quantizer.js';

// A small seeded PRNG, so a failure names the same rotation every run.
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

// The canonical sign: the largest component positive, as the codec stores it.
function canonical(q: number[]): number[] {
  let k = 0;
  for (let i = 1; i < 4; i += 1) if (Math.abs(q[i]) > Math.abs(q[k])) k = i;
  return q[k] < 0 ? q.map((v) => -v) : q;
}

describe('Quantizer positions', () => {
  const quantizer = new Quantizer();

  it('round-trips a position within 0.5 mm', () => {
    for (const metres of [0, 0.0004, -0.0006, 1.2345678, -250.0007, 9999.9996]) {
      const back = quantizer.unposition(quantizer.position(metres));
      expect(Math.abs(back - metres)).toBeLessThanOrEqual(0.0005 + 1e-12);
    }
  });

  it('clamps a position to i32 and maps a non-finite one to 0', () => {
    expect(quantizer.position(1e12)).toBe(0x7fffffff);
    expect(quantizer.position(-1e12)).toBe(-0x80000000);
    expect(quantizer.position(Number.NaN)).toBe(0);
  });
});

describe('packQuat / unpackQuat', () => {
  const out = new Float32Array(8);

  it('round-trips the identity exactly', () => {
    unpackQuat(packQuat(0, 0, 0, 1), out, 0);
    expect(Array.from(out.subarray(0, 4))).toEqual([0, 0, 0, 1]);
  });

  it('encodes q and -q to the same word', () => {
    const h = Math.SQRT1_2;
    expect(packQuat(0.1, -0.7, 0.2, h)).toBe(packQuat(-0.1, 0.7, -0.2, -h));
    expect(packQuat(0, -1, 0, 0)).toBe(packQuat(0, 1, 0, 0));
  });

  it('writes at the given offset and nowhere else', () => {
    out.fill(9);
    unpackQuat(packQuat(0, 0, 0, 1), out, 4);
    expect(Array.from(out)).toEqual([9, 9, 9, 9, 0, 0, 0, 1]);
  });

  it('round-trips 10,000 random rotations within 1e-3 per component', () => {
    const random = mulberry32(1391);
    let worst = 0;
    for (let n = 0; n < 10_000; n += 1) {
      const raw = [random() * 2 - 1, random() * 2 - 1, random() * 2 - 1, random() * 2 - 1];
      const length = Math.hypot(...raw);
      const q = canonical(raw.map((v) => v / length));
      unpackQuat(packQuat(q[0], q[1], q[2], q[3]), out, 0);
      for (let i = 0; i < 4; i += 1) worst = Math.max(worst, Math.abs(out[i] - q[i]));
    }
    expect(worst).toBeLessThan(1e-3);
  });

  it('maps a zero or non-finite quaternion to the identity', () => {
    unpackQuat(packQuat(0, 0, 0, 0), out, 0);
    expect(Array.from(out.subarray(0, 4))).toEqual([0, 0, 0, 1]);
    unpackQuat(packQuat(Number.NaN, 0, 0, 1), out, 0);
    expect(Array.from(out.subarray(0, 4))).toEqual([0, 0, 0, 1]);
  });

  it('decodes any 32-bit word to a unit quaternion', () => {
    const random = mulberry32(7);
    for (let n = 0; n < 1000; n += 1) {
      unpackQuat((random() * 4294967296) >>> 0, out, 0);
      const length = Math.hypot(out[0], out[1], out[2], out[3]);
      expect(Math.abs(length - 1)).toBeLessThan(1e-5);
    }
  });
});
