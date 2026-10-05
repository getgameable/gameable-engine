// The gaussians and their bindings packed into the 44-float records the deformation reads. Each property's byte
// offset is found once rather than once per splat per field, and no field name is built per splat: a 459k-splat
// export with 45 harmonics packs in about 0.2 s of main-thread work instead of about 2 s. `packFast.test.ts` checks it
// bit for bit against a packer written field by field, by name.

import type { GaussianPly } from './format.js';

const C0 = 0.28209479177387814;
const FLOAT_MAX = 3.4028234663852886e38;

/**
 * Pack original Gaussians and their bindings into one compute-friendly chunk.
 *
 * @param ply The parsed PLY.
 * @param bindings The parsed bindings (28 lanes a splat).
 * @param translation `plyToCharacter`.
 * @param start First splat.
 * @param count How many.
 * @returns The records (44 floats a splat), the harmonics and their count per splat.
 */
export function packGaussianChunk(
  ply: GaussianPly,
  bindings: Float32Array,
  translation: number[],
  start: number,
  count: number,
): { records: Float32Array; sh: Float32Array; shCount: number } {
  const records = new Float32Array(count * 44),
    sh = new Float32Array(Math.max(1, count * ply.shCount));
  const at = (name: string): number => {
    const lane = ply.properties.get(name);
    if (lane === undefined) throw new Error(`missing PLY ${name}`);
    return lane * 4;
  };
  const X = at('x'),
    Y = at('y'),
    Z = at('z'),
    R0 = at('rot_0'),
    R1 = at('rot_1'),
    R2 = at('rot_2'),
    R3 = at('rot_3'),
    S0 = at('scale_0'),
    S1 = at('scale_1'),
    S2 = at('scale_2'),
    D0 = at('f_dc_0'),
    D1 = at('f_dc_1'),
    D2 = at('f_dc_2'),
    O = at('opacity');
  const K = ply.shCount;
  const rest = Array.from({ length: K }, (_, k) => at(`f_rest_${String(k)}`));
  const data = ply.data,
    stride = ply.stride;
  const tx = translation[3],
    ty = translation[7],
    tz = translation[11];
  const read = (base: number, lane: number, name: string): number => {
    const value = data.getFloat32(base + lane, true);
    if (!Number.isFinite(value)) throw new Error(`aosrig-splat: nonfinite PLY ${name}`);
    return value;
  };
  let hasSh = false;
  for (let n = 0; n < count; n++) {
    const i = start + n,
      o = n * 44,
      base = i * stride;
    records[o] = read(base, X, 'x') + tx;
    records[o + 1] = read(base, Y, 'y') + ty;
    records[o + 2] = read(base, Z, 'z') + tz;
    records[o + 3] = 1;
    let w = read(base, R0, 'rot_0'),
      x = read(base, R1, 'rot_1'),
      y = read(base, R2, 'rot_2'),
      z = read(base, R3, 'rot_3');
    const length = Math.hypot(w, x, y, z);
    if (length < 1e-12) throw new Error('aosrig-splat: zero PLY quaternion');
    w /= length;
    x /= length;
    y /= length;
    z /= length;
    const r0 = 1 - 2 * (y * y + z * z),
      r1 = 2 * (x * y - z * w),
      r2 = 2 * (x * z + y * w),
      r3 = 2 * (x * y + z * w),
      r4 = 1 - 2 * (x * x + z * z),
      r5 = 2 * (y * z - x * w),
      r6 = 2 * (x * z - y * w),
      r7 = 2 * (y * z + x * w),
      r8 = 1 - 2 * (x * x + y * y);
    const s0 = Math.exp(2 * read(base, S0, 'scale_0')),
      s1 = Math.exp(2 * read(base, S1, 'scale_1')),
      s2 = Math.exp(2 * read(base, S2, 'scale_2'));
    if (
      !Number.isFinite(s0) ||
      s0 <= 0 ||
      s0 > FLOAT_MAX ||
      !Number.isFinite(s1) ||
      s1 <= 0 ||
      s1 > FLOAT_MAX ||
      !Number.isFinite(s2) ||
      s2 <= 0 ||
      s2 > FLOAT_MAX
    )
      throw new Error('aosrig-splat: invalid Gaussian scale');
    records[o + 4] = r0 * s0 * r0 + r1 * s1 * r1 + r2 * s2 * r2;
    records[o + 5] = r0 * s0 * r3 + r1 * s1 * r4 + r2 * s2 * r5;
    records[o + 6] = r0 * s0 * r6 + r1 * s1 * r7 + r2 * s2 * r8;
    records[o + 7] = r3 * s0 * r3 + r4 * s1 * r4 + r5 * s2 * r5;
    records[o + 8] = r3 * s0 * r6 + r4 * s1 * r7 + r5 * s2 * r8;
    records[o + 9] = r6 * s0 * r6 + r7 * s1 * r7 + r8 * s2 * r8;
    records[o + 12] = 0.5 + C0 * read(base, D0, 'f_dc_0');
    records[o + 13] = 0.5 + C0 * read(base, D1, 'f_dc_1');
    records[o + 14] = 0.5 + C0 * read(base, D2, 'f_dc_2');
    records[o + 15] = 1 / (1 + Math.exp(-read(base, O, 'opacity')));
    records.set(bindings.subarray(i * 28, i * 28 + 28), o + 16);
    const shAt = n * K;
    for (let k = 0; k < K; k++) {
      const value = data.getFloat32(base + rest[k], true);
      if (!Number.isFinite(value))
        throw new Error(`aosrig-splat: nonfinite PLY f_rest_${String(k)}`);
      sh[shAt + k] = value;
      if (value !== 0) hasSh = true;
    }
  }
  return { records, sh: hasSh ? sh : new Float32Array(1), shCount: hasSh ? K : 0 };
}
