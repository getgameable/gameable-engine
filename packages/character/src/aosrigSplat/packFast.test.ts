import { describe, expect, it } from 'vitest';
import { parseGaussianPly } from './format.js';
import type { GaussianPly } from './format.js';
import { packGaussianChunk } from './packFast.js';

/**
 * The packer written field by field, by name: the reference the fast one must match bit for bit.
 *
 * @param ply The character's gaussians.
 * @param bindings Their parsed bindings (`bindings.bin`).
 * @param translation The package's row-major 4×4 transform; its translation is added to every
 *   centre.
 * @param start The chunk's first gaussian.
 * @param count The chunk's gaussian count.
 * @returns The chunk's records, its harmonics and their count per gaussian.
 */
function packByName(
  ply: GaussianPly,
  bindings: Float32Array,
  translation: number[],
  start: number,
  count: number,
): { records: Float32Array; sh: Float32Array; shCount: number } {
  const records = new Float32Array(count * 44),
    sh = new Float32Array(Math.max(1, count * ply.shCount));
  let hasSh = false;
  const get = (i: number, name: string): number => {
    const value = ply.data.getFloat32(
      i * ply.stride +
        (ply.properties.get(name) ??
          (() => {
            throw new Error(`missing PLY ${name}`);
          })()) *
          4,
      true,
    );
    if (!Number.isFinite(value)) throw new Error(`aosrig-splat: nonfinite PLY ${name}`);
    return value;
  };
  for (let n = 0; n < count; n++) {
    const i = start + n,
      o = n * 44;
    records[o] = get(i, 'x') + translation[3];
    records[o + 1] = get(i, 'y') + translation[7];
    records[o + 2] = get(i, 'z') + translation[11];
    records[o + 3] = 1;
    let w = get(i, 'rot_0'),
      x = get(i, 'rot_1'),
      y = get(i, 'rot_2'),
      z = get(i, 'rot_3');
    const length = Math.hypot(w, x, y, z);
    if (length < 1e-12) throw new Error('aosrig-splat: zero PLY quaternion');
    w /= length;
    x /= length;
    y /= length;
    z /= length;
    const r = [
      1 - 2 * (y * y + z * z),
      2 * (x * y - z * w),
      2 * (x * z + y * w),
      2 * (x * y + z * w),
      1 - 2 * (x * x + z * z),
      2 * (y * z - x * w),
      2 * (x * z - y * w),
      2 * (y * z + x * w),
      1 - 2 * (x * x + y * y),
    ];
    const s = [
      Math.exp(2 * get(i, 'scale_0')),
      Math.exp(2 * get(i, 'scale_1')),
      Math.exp(2 * get(i, 'scale_2')),
    ];
    if (s.some((v) => !Number.isFinite(v) || v <= 0 || v > 3.4028234663852886e38))
      throw new Error('aosrig-splat: invalid Gaussian scale');
    const cov = (a: number, b: number): number =>
      r[a * 3] * s[0] * r[b * 3] +
      r[a * 3 + 1] * s[1] * r[b * 3 + 1] +
      r[a * 3 + 2] * s[2] * r[b * 3 + 2];
    records.set([cov(0, 0), cov(0, 1), cov(0, 2), cov(1, 1), cov(1, 2), cov(2, 2), 0, 0], o + 4);
    records.set(
      [
        0.5 + 0.28209479177387814 * get(i, 'f_dc_0'),
        0.5 + 0.28209479177387814 * get(i, 'f_dc_1'),
        0.5 + 0.28209479177387814 * get(i, 'f_dc_2'),
        1 / (1 + Math.exp(-get(i, 'opacity'))),
      ],
      o + 12,
    );
    records.set(bindings.subarray(i * 28, (i + 1) * 28), o + 16);
    for (let k = 0; k < ply.shCount; k++) {
      const value = get(i, `f_rest_${String(k)}`);
      sh[n * ply.shCount + k] = value;
      if (value !== 0) hasSh = true;
    }
  }
  return { records, sh: hasSh ? sh : new Float32Array(1), shCount: hasSh ? ply.shCount : 0 };
}

/** A binary PLY of `n` splats with `sh` harmonics, filled from a seeded sequence. */
function randomPly(n: number, sh: number): Uint8Array {
  const names = [
    'x',
    'y',
    'z',
    'f_dc_0',
    'f_dc_1',
    'f_dc_2',
    ...Array.from({ length: sh }, (_, k) => `f_rest_${String(k)}`),
    'opacity',
    'scale_0',
    'scale_1',
    'scale_2',
    'rot_0',
    'rot_1',
    'rot_2',
    'rot_3',
  ];
  const text = new TextEncoder().encode(
    `ply\nformat binary_little_endian 1.0\nelement vertex ${String(n)}\n` +
      names.map((p) => `property float ${p}\n`).join('') +
      'end_header\n',
  );
  const out = new Uint8Array(text.length + n * names.length * 4);
  out.set(text);
  const v = new DataView(out.buffer, text.length);
  let seed = 12345;
  const next = (): number => {
    seed = (seed * 1103515245 + 12345) >>> 0;
    return seed / 4294967296;
  };
  for (let i = 0; i < n; i++)
    names.forEach((name, k) => {
      const r = next();
      const value = name.startsWith('scale')
        ? -9 + 6 * r
        : name.startsWith('f_rest')
          ? (r - 0.5) * 0.8
          : (r - 0.5) * 4;
      v.setFloat32((i * names.length + k) * 4, value, true);
    });
  return out;
}

describe('packGaussianChunk', () => {
  it('gives the by-name reference’s records and harmonics bit for bit', () => {
    for (const sh of [0, 9, 45]) {
      const n = 300;
      const ply = parseGaussianPly(randomPly(n, sh), n);
      const bindings = new Float32Array(n * 28).map((_, i) => (i % 29) * 0.25);
      const t = [1, 0, 0, 0.01, 0, 1, 0, 1.31, 0, 0, 1, -0.02];
      const a = packByName(ply, bindings, t, 17, 250),
        b = packGaussianChunk(ply, bindings, t, 17, 250);
      expect(b.shCount).toBe(a.shCount);
      expect([...new Uint32Array(b.records.buffer)]).toEqual([
        ...new Uint32Array(a.records.buffer),
      ]);
      expect([...new Uint32Array(b.sh.buffer)]).toEqual([...new Uint32Array(a.sh.buffer)]);
    }
  });
});
