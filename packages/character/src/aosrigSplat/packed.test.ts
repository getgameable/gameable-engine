import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { floatToHalf, packAosRig, parseAosRig, type AosRigBlob } from '../rig/gnm/gnmPack.js';
import { parseBindings, parseDescriptor, parseGaussianPly, unpackFiles } from './format.js';
import { isPackedBindings, isPackedSplats, unpackBindings, unpackSplats } from './packed.js';

const fixture = new URL('../../test/fixtures/aosrig-splat/', import.meta.url);
const bytes = (name: string): Uint8Array => new Uint8Array(readFileSync(new URL(name, fixture)));

/** The studio lab's packer (tools/pack_lab/pack_package.py in the studio), for the test: one file's planes. */
function packSplats(plain: Uint8Array, count: number, posBits: 16 | 24 = 24): Uint8Array {
  const ply = parseGaussianPly(plain, count);
  const props = [...ply.properties.keys()];
  const get = (i: number, name: string): number =>
    ply.data.getFloat32(i * ply.stride + (ply.properties.get(name) ?? 0) * 4, true);
  const column = (name: string): number[] => Array.from({ length: count }, (_, i) => get(i, name));
  const range = (v: number[]): [number, number] => [Math.min(...v), Math.max(...v)];
  const quant = (v: number, lo: number, hi: number, steps: number): number =>
    hi > lo ? Math.min(steps, Math.max(0, Math.round(((v - lo) / (hi - lo)) * steps))) : 0;
  const planes: [string, Uint8Array][] = [];
  const ranges = {
    pos: { min: [] as number[], max: [] as number[] },
    scale: { min: [] as number[], max: [] as number[] },
    dc: { min: [] as number[], max: [] as number[] },
    sh: [] as number[],
  };
  for (const axis of ['x', 'y', 'z']) {
    const v = column(axis),
      [lo, hi] = range(v);
    ranges.pos.min.push(lo);
    ranges.pos.max.push(hi);
    const q = v.map((x) => quant(x, lo, hi, posBits === 24 ? 16777215 : 65535));
    if (posBits === 24) {
      planes.push([`pos_${axis}_hi`, Uint8Array.from(q, (x) => x >>> 16)]);
      planes.push([`pos_${axis}_mid`, Uint8Array.from(q, (x) => (x >>> 8) & 255)]);
    } else planes.push([`pos_${axis}_hi`, Uint8Array.from(q, (x) => x >>> 8)]);
    planes.push([`pos_${axis}_lo`, Uint8Array.from(q, (x) => x & 255)]);
  }
  for (let k = 0; k < 3; k++) {
    const v = column(`scale_${String(k)}`),
      [lo, hi] = range(v);
    ranges.scale.min.push(lo);
    ranges.scale.max.push(hi);
    planes.push([`scale_${String(k)}`, Uint8Array.from(v, (x) => quant(x, lo, hi, 255))]);
  }
  const rot = new Uint8Array(count * 4),
    rv = new DataView(rot.buffer);
  for (let i = 0; i < count; i++) {
    let q = [0, 1, 2, 3].map((k) => get(i, `rot_${String(k)}`));
    const n = Math.hypot(...q);
    q = q.map((x) => x / n);
    let big = 0;
    for (let k = 1; k < 4; k++) if (Math.abs(q[k]) > Math.abs(q[big])) big = k;
    if (q[big] < 0) q = q.map((x) => -x);
    let word = big << 30,
      slot = 0;
    for (let k = 0; k < 4; k++) {
      if (k === big) continue;
      const u = Math.min(1023, Math.max(0, Math.round((q[k] / Math.SQRT1_2 + 1) * 0.5 * 1023)));
      word |= u << (20 - 10 * slot++);
    }
    rv.setUint32(i * 4, word >>> 0, true);
  }
  planes.push(['rot', rot]);
  planes.push([
    'opacity',
    Uint8Array.from(column('opacity'), (o) => Math.round(255 / (1 + Math.exp(-o)))),
  ]);
  for (let k = 0; k < 3; k++) {
    const v = column(`f_dc_${String(k)}`),
      [lo, hi] = range(v);
    ranges.dc.min.push(lo);
    ranges.dc.max.push(hi);
    planes.push([`dc_${String(k)}`, Uint8Array.from(v, (x) => quant(x, lo, hi, 255))]);
  }
  for (let k = 0; k < ply.shCount; k++) {
    const v = column(`f_rest_${String(k)}`),
      m = Math.max(...v.map(Math.abs));
    ranges.sh.push(m);
    planes.push([
      `sh_${String(k)}`,
      Uint8Array.from(v, (x) => (m === 0 ? 127 : Math.round((x / m) * 127) + 127)),
    ]);
  }
  const header = {
    format: 'aosrig-splat-packed',
    version: 1,
    count,
    shCount: ply.shCount,
    properties: props,
    posBits,
    ranges,
    planes: [] as { name: string; offset: number; bytes: number }[],
    totalBytes: 0,
  };
  let text = new Uint8Array(0);
  for (let pass = 0; pass < 4; pass++) {
    let off = (12 + text.length + 3) & ~3;
    header.planes = planes.map(([name, data]) => {
      const entry = { name, offset: off, bytes: data.length };
      off = (off + data.length + 3) & ~3;
      return entry;
    });
    header.totalBytes = off;
    const next = new TextEncoder().encode(JSON.stringify(header));
    const settled = next.length === text.length;
    text = next;
    if (settled) break;
  }
  const out = new Uint8Array(header.totalBytes);
  out.set(new TextEncoder().encode('AOSPSP01'));
  new DataView(out.buffer).setUint32(8, text.length, true);
  out.set(text, 12);
  planes.forEach(([, data], i) => {
    out.set(data, header.planes[i].offset);
  });
  return out;
}

/** A small head: four vertices, two triangles, at rest as the character stands. */
const REST = Float64Array.from([0, 1.5, 0.1, 0.01, 1.5, 0.1, 0, 1.51, 0.1, 0.01, 1.51, 0.11]);

/** Plain bindings for three splats: body only, bound to triangle (0,1,2), bound to (1,3,2). */
function plainBindings(): { bytes: Uint8Array; d: Parameters<typeof unpackBindings>[1] } {
  const n = 3,
    out = new Uint8Array(32 + n * 112),
    v = new DataView(out.buffer);
  out.set(new TextEncoder().encode('AOSBND01'));
  [1, n, 112, 4, 5, 0].forEach((x, k) => {
    v.setUint32(8 + k * 4, x, true);
  });
  const f = new Float32Array(out.buffer, 32),
    u = new Uint32Array(out.buffer, 32);
  const tris = [null, [0, 1, 2], [1, 3, 2]] as const;
  const weights = [
    [1, 0, 0, 0],
    [0.5, 0.25, 0.125, 0.125],
    [0.7, 0.2, 0.1, 0],
  ];
  for (let i = 0; i < n; i++) {
    const b = i * 28;
    for (let k = 0; k < 4; k++) {
      u[b + k] = (i + k) % 5;
      f[b + 4 + k] = weights[i][k];
    }
    f[b + 12] = 1;
    f[b + 17] = 1;
    f[b + 22] = 1;
    const t = tris[i];
    if (!t) continue;
    u[b + 8] = t[0];
    u[b + 9] = t[1];
    u[b + 10] = t[2];
    f[b + 11] = i === 1 ? 1 : 0.4;
    const p = (j: number, c: number): number => REST[t[j] * 3 + c];
    const e1 = [0, 1, 2].map((c) => p(1, c) - p(0, c)),
      e2 = [0, 1, 2].map((c) => p(2, c) - p(0, c));
    const nn = [
      e1[1] * e2[2] - e1[2] * e2[1],
      e1[2] * e2[0] - e1[0] * e2[2],
      e1[0] * e2[1] - e1[1] * e2[0],
    ];
    const len = Math.hypot(...nn);
    const m = [0, 1, 2].map((r) => [e1[r], e2[r], nn[r] / len]);
    const det =
      m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) -
      m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) +
      m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
    const cof = (r: number, c: number): number => {
      const rr = [0, 1, 2].filter((x) => x !== r),
        cc = [0, 1, 2].filter((x) => x !== c);
      return (
        ((r + c) % 2 ? -1 : 1) *
        (m[rr[0]][cc[0]] * m[rr[1]][cc[1]] - m[rr[0]][cc[1]] * m[rr[1]][cc[0]])
      );
    };
    for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) f[b + 12 + r * 4 + c] = cof(c, r) / det;
    for (let c = 0; c < 3; c++) f[b + 24 + c] = p(0, c);
  }
  return {
    bytes: out,
    d: { splatCount: n, headVertexCount: 4, jointNames: ['a', 'b', 'c', 'd', 'c_head'] },
  };
}

/** The same three splats packed: 20 bytes each. */
function packBindings(plain: Uint8Array, n: number): Uint8Array {
  const f = new Float32Array(plain.buffer.slice(plain.byteOffset + 32)),
    u = new Uint32Array(f.buffer);
  const out = new Uint8Array(32 + n * 20),
    v = new DataView(out.buffer);
  out.set(plain.subarray(0, 32));
  out.set(new TextEncoder().encode('AOSBNP01'));
  v.setUint32(16, 20, true);
  for (let i = 0; i < n; i++) {
    const b = i * 28;
    const w = [0, 1, 2, 3].map((k) => f[b + 4 + k] * 65535);
    const q = w.map(Math.floor);
    let short = 65535 - q.reduce((s, x) => s + x, 0);
    [0, 1, 2, 3]
      .sort((a, c) => w[c] - q[c] - (w[a] - q[a]))
      .forEach((k) => {
        if (short-- > 0) q[k]++;
      });
    for (let k = 0; k < 4; k++) {
      out[32 + k * n + i] = u[b + k];
      v.setUint16(32 + 4 * n + k * 2 * n + i * 2, q[k], true);
    }
    for (let k = 0; k < 3; k++) v.setUint16(32 + 12 * n + k * 2 * n + i * 2, u[b + 8 + k], true);
    v.setUint16(32 + 18 * n + i * 2, Math.round(f[b + 11] * 65535), true);
  }
  return out;
}

describe('packed character files', () => {
  it('reads packed splats back as the same PLY within the packing steps', () => {
    const plain = bytes('character.ply');
    for (const bits of [24, 16] as const) {
      const packed = packSplats(plain, 2, bits);
      expect(isPackedSplats(packed)).toBe(true);
      expect(isPackedSplats(plain)).toBe(false);
      const a = parseGaussianPly(plain, 2),
        b = parseGaussianPly(unpackSplats(packed, 2), 2);
      expect([...b.properties.keys()]).toEqual([...a.properties.keys()]);
      const at = (p: typeof a, i: number, name: string): number =>
        p.data.getFloat32(i * p.stride + (p.properties.get(name) ?? 0) * 4, true);
      for (let i = 0; i < 2; i++) {
        for (const axis of ['x', 'y', 'z'])
          expect(Math.abs(at(b, i, axis) - at(a, i, axis))).toBeLessThan(bits === 24 ? 1e-6 : 3e-5);
        const sig = (o: number): number => 1 / (1 + Math.exp(-o));
        expect(Math.abs(sig(at(b, i, 'opacity')) - sig(at(a, i, 'opacity')))).toBeLessThan(
          0.5 / 255 + 1e-6,
        );
        const qa = [0, 1, 2, 3].map((k) => at(a, i, `rot_${String(k)}`)),
          qb = [0, 1, 2, 3].map((k) => at(b, i, `rot_${String(k)}`));
        const na = Math.hypot(...qa);
        const dot = Math.abs(qa.reduce((s, x, k) => s + (x / na) * qb[k], 0));
        expect(dot).toBeGreaterThan(Math.cos(0.3 * (Math.PI / 180)));
      }
    }
  });

  it('refuses a packed file whose count is not the descriptor’s', () => {
    const packed = packSplats(bytes('character.ply'), 2);
    expect(() => unpackSplats(packed, 3)).toThrow(/unsupported header/);
    expect(() => unpackSplats(packed.subarray(0, packed.length - 4), 2)).toThrow();
  });

  it('rebuilds the face half of the bindings from the head at rest', () => {
    const { bytes: plain, d } = plainBindings();
    const packed = packBindings(plain, 3);
    expect(isPackedBindings(packed)).toBe(true);
    const back = parseBindings(
      unpackBindings(packed, d, REST),
      d as ReturnType<typeof parseDescriptor>,
    );
    const orig = new Float32Array(plain.buffer.slice(32)),
      ou = new Uint32Array(orig.buffer),
      bu = new Uint32Array(back.buffer);
    for (let i = 0; i < 3; i++) {
      const b = i * 28;
      for (let k = 0; k < 4; k++) {
        expect(bu[b + k]).toBe(ou[b + k]);
        expect(Math.abs(back[b + 4 + k] - orig[b + 4 + k])).toBeLessThan(1 / 65535);
      }
      expect(Math.abs(back[b + 11] - orig[b + 11])).toBeLessThan(1 / 65535);
      for (let k = 8; k < 11; k++) expect(bu[b + k]).toBe(ou[b + k]);
      for (const k of [12, 13, 14, 16, 17, 18, 20, 21, 22, 24, 25, 26])
        expect(back[b + k]).toBeCloseTo(orig[b + k], 3);
    }
    expect(() => unpackBindings(packed, d, REST.subarray(0, 9))).toThrow(/rest mesh/);
  });

  it('unpacks a package’s files in place and leaves plain ones alone', async () => {
    const { bytes: plain, d } = plainBindings();
    const neutral = Float32Array.from(REST);
    const blobs: AosRigBlob[] = [
      { name: 'neutral', dtype: 'f32', shape: [4, 3], data: neutral },
      { name: 'basis', dtype: 'u32', shape: [6], data: new Uint32Array(6) },
      { name: 'basisScale', dtype: 'f32', shape: [1], data: Float32Array.from([1]) },
      { name: 'skinIndex', dtype: 'u16', shape: [4, 4], data: new Uint16Array(16) },
      { name: 'skinWeight', dtype: 'f16', shape: [4, 4], data: new Uint16Array(16) },
      { name: 'eyePositions', dtype: 'f32', shape: [2, 3], data: new Float32Array(6) },
      { name: 'eyeWeights', dtype: 'f32', shape: [2, 4], data: new Float32Array(8) },
      {
        name: 'restWorld',
        dtype: 'f32',
        shape: [1, 4, 4],
        data: Float32Array.from([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]),
      },
      { name: 'jointParents', dtype: 'i32', shape: [1], data: Int32Array.from([-1]) },
      { name: 'faces', dtype: 'u32', shape: [2, 3], data: Uint32Array.from([0, 1, 2, 1, 3, 2]) },
    ];
    const head = packAosRig(
      {
        version: 1,
        model: 'gnm',
        vertexCount: 4,
        coeffCount: 1,
        maxInfluence: 4,
        units: 'm',
        headExt: {
          dim: 5,
          exprDim: 1,
          gazeDim: 4,
          regions: [['lower_face', 1]],
          reduced: { lower_face: 1 },
        },
        joints: [{ name: 'c_head', parent: -1 }],
        eyes: { names: ['l', 'r'] },
        bindTransform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
      },
      blobs,
    );
    const files = new Map([
      ['bindings.bin', packBindings(plain, 3)],
      ['head.aosrig', head],
    ]);
    await unpackFiles(files, { ...d, format: 'aosrig-splat' } as ReturnType<
      typeof parseDescriptor
    >);
    expect(new TextDecoder().decode(files.get('bindings.bin')?.subarray(0, 8))).toBe('AOSBND01');
    const untouched = new Map([['bindings.bin', plain]]);
    await unpackFiles(untouched, d as ReturnType<typeof parseDescriptor>);
    expect(untouched.get('bindings.bin')).toBe(plain);
  });

  it('reads a lighter head: half-precision shape, 16-bit triangles, an 8-bit expression table', () => {
    const blobs = (light: boolean): AosRigBlob[] => [
      light
        ? {
            name: 'neutral',
            dtype: 'f16',
            shape: [2, 3],
            data: Uint16Array.from([0, 0.5, 1, 1, 2, 3], floatToHalf),
          }
        : {
            name: 'neutral',
            dtype: 'f32',
            shape: [2, 3],
            data: Float32Array.from([0, 0.5, 1, 1, 2, 3]),
          },
      light
        ? {
            name: 'basis',
            dtype: 'i8',
            shape: [12],
            data: Int8Array.from([1, -2, 3, 127, -127, 0, 5, 6, 7, 8, 9, 10]),
          }
        : {
            name: 'basis',
            dtype: 'u32',
            shape: [6],
            data: new Uint32Array(
              Uint16Array.from([1, -2, 3, 127, -127, 0, 5, 6, 7, 8, 9, 10], floatToHalf).buffer,
            ),
          },
      { name: 'basisScale', dtype: 'f32', shape: [2], data: Float32Array.from([0.001, 0.002]) },
      { name: 'skinIndex', dtype: 'u16', shape: [2, 4], data: new Uint16Array(8) },
      { name: 'skinWeight', dtype: 'f16', shape: [2, 4], data: new Uint16Array(8) },
      { name: 'eyePositions', dtype: 'f32', shape: [2, 3], data: new Float32Array(6) },
      light
        ? {
            name: 'eyeWeights',
            dtype: 'f16',
            shape: [2, 2],
            data: Uint16Array.from([1, 0, 0, 1], floatToHalf),
          }
        : {
            name: 'eyeWeights',
            dtype: 'f32',
            shape: [2, 2],
            data: Float32Array.from([1, 0, 0, 1]),
          },
      {
        name: 'restWorld',
        dtype: 'f32',
        shape: [1, 4, 4],
        data: Float32Array.from([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]),
      },
      { name: 'jointParents', dtype: 'i32', shape: [1], data: Int32Array.from([-1]) },
      light
        ? { name: 'faces', dtype: 'u16', shape: [1, 3], data: Uint16Array.from([0, 1, 0]) }
        : { name: 'faces', dtype: 'u32', shape: [1, 3], data: Uint32Array.from([0, 1, 0]) },
    ];
    const header = {
      version: 1,
      model: 'gnm' as const,
      vertexCount: 2,
      coeffCount: 2,
      maxInfluence: 4,
      units: 'm' as const,
      headExt: {
        dim: 6,
        exprDim: 2,
        gazeDim: 4,
        regions: [['lower_face', 2]] as [string, number][],
        reduced: {},
      },
      joints: [{ name: 'c_head', parent: -1 }],
      eyes: { names: ['l', 'r'] },
      bindTransform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
    };
    const plain = parseAosRig(packAosRig(header, blobs(false)));
    const light = parseAosRig(packAosRig(header, blobs(true)));
    expect(light.neutral).toBeInstanceOf(Float32Array);
    expect([...light.neutral]).toEqual([...plain.neutral]);
    expect([...light.basis]).toEqual([...plain.basis]);
    expect(light.faces).toBeInstanceOf(Uint32Array);
    expect([...light.faces]).toEqual([...plain.faces]);
    expect([...light.eyeWeights]).toEqual([...plain.eyeWeights]);
  });
});
