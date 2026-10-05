// Packed character files: the same splats and bindings in about a quarter of the bytes, read back into
// the plain files the rest of the engine reads. The loader calls these right after a file's hash is
// checked (format.ts), so the runtime, the mouth and the captured-light reader never see a packed file.
//
// PACKED SPLATS ("AOSPSP01", named in character.json under the key character.ply):
//   0   "AOSPSP01"
//   8   u32 headerLen
//   12  JSON header (utf8), space-padded; then planes on 4-byte boundaries at the offsets it lists
//   position   three u8 planes per axis (hi, mid, lo): 24-bit fixed point over the file's [min, max]
//              (or two, hi and lo, 16-bit, when the header's posBits is 16)
//   scale_k    u8: the PLY's log scale over [min, max] per axis
//   rot        u32: smallest three; bits 30-31 the largest component's index (kept >= 0), then three
//              10-bit components of the others, in index order, over [-1/sqrt2, 1/sqrt2]
//   opacity    u8: the opacity after the sigmoid, x 255 (the 8 bits the GPU keeps of it)
//   dc_k       u8: f_dc over [min, max] per channel
//   sh_k       u8: f_rest_k over [-m_k, m_k], 127 = 0, in 127 steps a side (or the header's shLevels[k],
//              fewer steps for a coarser file)
//
// PACKED BINDINGS ("AOSBNP01", under the key bindings.bin): the 32-byte header of the plain file with
// 20 bytes a splat, then planes: joints u8 x4, weights u16 x4 (/65535, summing to 65535), the face
// triangle u16 x3, blend u16 (/65535). The inverse rest frame and the rest origin are rebuilt from the
// triangle and the head's rest mesh: what the studio's exporter computes them from.

import type { AosrigSplatDescriptor } from './format.js';

const SPLAT_MAGIC = 'AOSPSP01';
const BINDING_MAGIC = 'AOSBNP01';
const POS_STEPS = 16777215;
const SQRT1_2 = 0.7071067811865476;
const REQUIRED = [
  'x',
  'y',
  'z',
  'opacity',
  'scale_0',
  'scale_1',
  'scale_2',
  'rot_0',
  'rot_1',
  'rot_2',
  'rot_3',
  'f_dc_0',
  'f_dc_1',
  'f_dc_2',
];

interface Plane {
  name: string;
  offset: number;
  bytes: number;
}

interface PackedSplatHeader {
  format: string;
  version: number;
  count: number;
  shCount: number;
  properties: string[];
  ranges: {
    pos: { min: number[]; max: number[] };
    scale: { min: number[]; max: number[] };
    dc: { min: number[]; max: number[] };
    sh: number[];
  };
  planes: Plane[];
  totalBytes: number;
  /** 24 (the default) or 16. */
  posBits?: number;
  /** Steps a side of zero per colour coefficient; 127 each when absent. */
  shLevels?: number[];
}

/** One decode pass over a range of rows. */
type Step = (from: number, to: number) => void;
/** A decode as steps over rows, and what it returns once they have all run. */
interface Job {
  count: number;
  steps: Step[];
  finish: () => Uint8Array;
}
/** Rows a block decodes between pauses. */
const BLOCK = 32768;

const runJob = (job: Job): Uint8Array => {
  for (const step of job.steps) step(0, job.count);
  return job.finish();
};

const runJobAsync = async (job: Job, pause: () => Promise<void>): Promise<Uint8Array> => {
  for (const step of job.steps)
    for (let from = 0; from < job.count; from += BLOCK) {
      step(from, Math.min(job.count, from + BLOCK));
      await pause();
    }
  return job.finish();
};

const magicOf = (bytes: Uint8Array): string =>
  bytes.length < 8 ? '' : String.fromCharCode(...bytes.subarray(0, 8));

/** Is this file the packed splats? */
export function isPackedSplats(bytes: Uint8Array): boolean {
  return magicOf(bytes) === SPLAT_MAGIC;
}

/** Is this file the packed bindings? */
export function isPackedBindings(bytes: Uint8Array): boolean {
  return magicOf(bytes) === BINDING_MAGIC;
}

const bad = (what: string): never => {
  throw new Error(`aosrig-splat: packed splats: ${what}`);
};
const finiteList = (v: unknown, n: number): v is number[] =>
  Array.isArray(v) && v.length === n && v.every((x) => typeof x === 'number' && Number.isFinite(x));

/**
 * The packed splats' decode, as steps over ranges of rows.
 *
 * @param bytes The packed file.
 * @param expected The descriptor's splat count.
 * @returns The job.
 */
function prepareSplats(bytes: Uint8Array, expected: number): Job {
  if (!isPackedSplats(bytes) || bytes.length < 12) bad('not a packed splat file');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const headerLen = view.getUint32(8, true);
  if (12 + headerLen > bytes.length) bad('header runs past the end');
  let h: PackedSplatHeader;
  try {
    h = JSON.parse(
      new TextDecoder().decode(bytes.subarray(12, 12 + headerLen)),
    ) as PackedSplatHeader;
  } catch {
    return bad('header is not JSON');
  }
  const N = h.count;
  const K = h.shCount;
  if (
    h.format !== 'aosrig-splat-packed' ||
    h.version !== 1 ||
    N !== expected ||
    !Number.isSafeInteger(N) ||
    ![0, 9, 24, 45].includes(K) ||
    h.totalBytes !== bytes.length ||
    ![undefined, 16, 24].includes(h.posBits) ||
    (h.shLevels !== undefined &&
      (!finiteList(h.shLevels, K) || h.shLevels.some((l) => l < 1 || l > 127))) ||
    !Array.isArray(h.properties) ||
    REQUIRED.some((p) => !h.properties.includes(p)) ||
    new Set(h.properties).size !== h.properties.length ||
    h.properties.filter((p) => p.startsWith('f_rest_')).length !== K ||
    h.properties.some((p) => !/^\w+$/.test(p)) ||
    !finiteList(h.ranges.pos.min, 3) ||
    !finiteList(h.ranges.pos.max, 3) ||
    !finiteList(h.ranges.scale.min, 3) ||
    !finiteList(h.ranges.scale.max, 3) ||
    !finiteList(h.ranges.dc.min, 3) ||
    !finiteList(h.ranges.dc.max, 3) ||
    !finiteList(h.ranges.sh, K)
  )
    bad('unsupported header');
  const planes = new Map(h.planes.map((p) => [p.name, p]));
  const plane = (name: string, width: number): Uint8Array => {
    const p = planes.get(name);
    if (
      !p ||
      p.bytes !== N * width ||
      p.offset < 12 + headerLen ||
      p.offset + p.bytes > bytes.length
    )
      return bad(`plane ${name} is missing or the wrong size`);
    return bytes.subarray(p.offset, p.offset + p.bytes);
  };
  const P = h.properties.length;
  const col = new Map(h.properties.map((p, i) => [p, i]));
  const at = (name: string): number => col.get(name) ?? bad(`no ${name}`);
  const text = new TextEncoder().encode(
    `ply\nformat binary_little_endian 1.0\nelement vertex ${String(N)}\n` +
      h.properties.map((p) => `property float ${p}\n`).join('') +
      'end_header\n',
  );
  const out = new Uint8Array(text.length + N * P * 4);
  out.set(text);
  // The rows start right after the header text, which need not be 4-byte aligned: build them in an
  // aligned array, then copy.
  const rows = new Float32Array(N * P);
  const r = h.ranges;
  const wide = (h.posBits ?? 24) === 24;
  const steps: Step[] = [];
  ['x', 'y', 'z'].forEach((axis, a) => {
    const hi = plane(`pos_${axis}_hi`, 1),
      lo = plane(`pos_${axis}_lo`, 1);
    const min = r.pos.min[a],
      c = at(axis);
    if (wide) {
      const mid = plane(`pos_${axis}_mid`, 1);
      const step = (r.pos.max[a] - min) / POS_STEPS;
      steps.push((from, to) => {
        for (let i = from; i < to; i++)
          rows[i * P + c] = min + ((hi[i] << 16) | (mid[i] << 8) | lo[i]) * step;
      });
    } else {
      const step = (r.pos.max[a] - min) / 65535;
      steps.push((from, to) => {
        for (let i = from; i < to; i++) rows[i * P + c] = min + ((hi[i] << 8) | lo[i]) * step;
      });
    }
  });
  for (let k = 0; k < 3; k++) {
    const q = plane(`scale_${String(k)}`, 1);
    const min = r.scale.min[k],
      step = (r.scale.max[k] - min) / 255,
      c = at(`scale_${String(k)}`);
    steps.push((from, to) => {
      for (let i = from; i < to; i++) rows[i * P + c] = min + q[i] * step;
    });
  }
  const rot = plane('rot', 4);
  const rv = new DataView(rot.buffer, rot.byteOffset, rot.byteLength);
  const rc = [0, 1, 2, 3].map((k) => at(`rot_${String(k)}`));
  const quat = [0, 0, 0, 0];
  steps.push((from, to) => {
    for (let i = from; i < to; i++) {
      const word = rv.getUint32(i * 4, true);
      const big = word >>> 30;
      const c0 = (((word >>> 20) & 1023) / 1023) * 2 - 1,
        c1 = (((word >>> 10) & 1023) / 1023) * 2 - 1,
        c2 = ((word & 1023) / 1023) * 2 - 1;
      const a0 = c0 * SQRT1_2,
        a1 = c1 * SQRT1_2,
        a2 = c2 * SQRT1_2;
      const largest = Math.sqrt(Math.max(0, 1 - a0 * a0 - a1 * a1 - a2 * a2));
      let s = 0;
      for (let k = 0; k < 4; k++) quat[k] = k === big ? largest : [a0, a1, a2][s++];
      for (let k = 0; k < 4; k++) rows[i * P + rc[k]] = quat[k];
    }
  });
  const opacity = plane('opacity', 1),
    oc = at('opacity');
  steps.push((from, to) => {
    for (let i = from; i < to; i++) {
      const q = opacity[i];
      const a = q === 0 ? 0.25 / 255 : q === 255 ? 1 - 0.25 / 255 : q / 255;
      rows[i * P + oc] = Math.log(a / (1 - a));
    }
  });
  for (let k = 0; k < 3; k++) {
    const q = plane(`dc_${String(k)}`, 1);
    const min = r.dc.min[k],
      step = (r.dc.max[k] - min) / 255,
      c = at(`f_dc_${String(k)}`);
    steps.push((from, to) => {
      for (let i = from; i < to; i++) rows[i * P + c] = min + q[i] * step;
    });
  }
  for (let k = 0; k < K; k++) {
    const q = plane(`sh_${String(k)}`, 1);
    const step = r.sh[k] / (h.shLevels?.[k] ?? 127),
      c = at(`f_rest_${String(k)}`);
    steps.push((from, to) => {
      for (let i = from; i < to; i++) rows[i * P + c] = (q[i] - 127) * step;
    });
  }
  return {
    count: N,
    steps,
    finish: () => {
      out.set(new Uint8Array(rows.buffer), text.length);
      return out;
    },
  };
}

/**
 * The packed splats back as the plain binary PLY (the same properties, in the same order).
 *
 * @param bytes The packed file.
 * @param expected The descriptor's splat count.
 * @returns The PLY's bytes, for `parseGaussianPly`.
 */
export function unpackSplats(bytes: Uint8Array, expected: number): Uint8Array {
  return runJob(prepareSplats(bytes, expected));
}

/**
 * {@link unpackSplats} in blocks, letting frames draw between them (a character built behind one already on
 * screen). The same bytes.
 *
 * @param bytes The packed file.
 * @param expected The descriptor's splat count.
 * @param pause Awaited between blocks; `frameBudget` makes one that waits only when a frame is due.
 * @returns The PLY's bytes.
 */
export function unpackSplatsAsync(
  bytes: Uint8Array,
  expected: number,
  pause: () => Promise<void>,
): Promise<Uint8Array> {
  return runJobAsync(prepareSplats(bytes, expected), pause);
}

/**
 * The packed bindings back as the plain 112-byte records (`AOSBND01`), the face half rebuilt from the
 * head's rest mesh.
 *
 * @param bytes The packed file.
 * @param d The package's descriptor (splat count, head vertex count, joint names).
 * @param rest The head's rest vertices in the character's frame, x y z each (mouth.ts `restVertices`).
 * @returns The plain file's bytes, for `parseBindings`.
 */
function prepareBindings(
  bytes: Uint8Array,
  d: Pick<AosrigSplatDescriptor, 'splatCount' | 'headVertexCount' | 'jointNames'>,
  rest: ArrayLike<number>,
): Job {
  const fail = (what: string): never => {
    throw new Error(`aosrig-splat: packed bindings: ${what}`);
  };
  const N = d.splatCount;
  if (!isPackedBindings(bytes) || bytes.length !== 32 + N * 20) fail('bad magic or size');
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (
    v.getUint32(8, true) !== 1 ||
    v.getUint32(12, true) !== N ||
    v.getUint32(16, true) !== 20 ||
    v.getUint32(20, true) !== d.headVertexCount ||
    v.getUint32(24, true) !== d.jointNames.length ||
    v.getUint32(28, true) !== 0
  )
    fail('header disagrees with the descriptor');
  if (rest.length !== d.headVertexCount * 3) fail('the head rest mesh is the wrong size');
  const out = new Uint8Array(32 + N * 112);
  const ov = new DataView(out.buffer);
  out.set(new TextEncoder().encode('AOSBND01'));
  [1, N, 112, d.headVertexCount, d.jointNames.length, 0].forEach((x, k) => {
    ov.setUint32(8 + k * 4, x, true);
  });
  const f = new Float32Array(out.buffer, 32, N * 28);
  const u = new Uint32Array(out.buffer, 32, N * 28);
  const J = 32,
    W = J + 4 * N,
    F = W + 8 * N,
    B = F + 6 * N;
  const step: Step = (from, to) => {
    for (let i = from; i < to; i++) {
      const b = i * 28;
      for (let k = 0; k < 4; k++) {
        const joint = bytes[J + k * N + i];
        if (joint >= d.jointNames.length) fail('joint out of range');
        u[b + k] = joint;
        f[b + 4 + k] = v.getUint16(W + k * 2 * N + i * 2, true) / 65535;
      }
      const blend = v.getUint16(B + i * 2, true);
      f[b + 11] = blend / 65535;
      f[b + 12] = 1;
      f[b + 17] = 1;
      f[b + 22] = 1;
      if (blend === 0) continue;
      const t0 = v.getUint16(F + i * 2, true),
        t1 = v.getUint16(F + 2 * N + i * 2, true),
        t2 = v.getUint16(F + 4 * N + i * 2, true);
      if (t0 >= d.headVertexCount || t1 >= d.headVertexCount || t2 >= d.headVertexCount)
        fail('face vertex out of range');
      u[b + 8] = t0;
      u[b + 9] = t1;
      u[b + 10] = t2;
      // The rest frame's columns: the two edges from the first corner and the unit normal.
      const ax = rest[t0 * 3],
        ay = rest[t0 * 3 + 1],
        az = rest[t0 * 3 + 2];
      const m00 = rest[t1 * 3] - ax,
        m10 = rest[t1 * 3 + 1] - ay,
        m20 = rest[t1 * 3 + 2] - az;
      const m01 = rest[t2 * 3] - ax,
        m11 = rest[t2 * 3 + 1] - ay,
        m21 = rest[t2 * 3 + 2] - az;
      let nx = m10 * m21 - m20 * m11,
        ny = m20 * m01 - m00 * m21,
        nz = m00 * m11 - m10 * m01;
      const area = Math.hypot(nx, ny, nz);
      if (!(area > 1e-10)) fail('a bound splat names a degenerate triangle');
      nx /= area;
      ny /= area;
      nz /= area;
      const m02 = nx,
        m12 = ny,
        m22 = nz;
      const det =
        m00 * (m11 * m22 - m12 * m21) -
        m01 * (m10 * m22 - m12 * m20) +
        m02 * (m10 * m21 - m11 * m20);
      // The inverse's rows, as the plain record keeps them (lanes 12-14, 16-18, 20-22).
      f[b + 12] = (m11 * m22 - m12 * m21) / det;
      f[b + 13] = (m02 * m21 - m01 * m22) / det;
      f[b + 14] = (m01 * m12 - m02 * m11) / det;
      f[b + 16] = (m12 * m20 - m10 * m22) / det;
      f[b + 17] = (m00 * m22 - m02 * m20) / det;
      f[b + 18] = (m02 * m10 - m00 * m12) / det;
      f[b + 20] = (m10 * m21 - m11 * m20) / det;
      f[b + 21] = (m01 * m20 - m00 * m21) / det;
      f[b + 22] = (m00 * m11 - m01 * m10) / det;
      f[b + 24] = ax;
      f[b + 25] = ay;
      f[b + 26] = az;
    }
  };
  return { count: N, steps: [step], finish: () => out };
}

/**
 * The packed bindings back as the plain 112-byte records (`AOSBND01`), the face half rebuilt from the
 * head's rest mesh.
 *
 * @param bytes The packed file.
 * @param d The package's descriptor (splat count, head vertex count, joint names).
 * @param rest The head's rest vertices in the character's frame, x y z each (mouth.ts `restVertices`).
 * @returns The plain file's bytes, for `parseBindings`.
 */
export function unpackBindings(
  bytes: Uint8Array,
  d: Pick<AosrigSplatDescriptor, 'splatCount' | 'headVertexCount' | 'jointNames'>,
  rest: ArrayLike<number>,
): Uint8Array {
  return runJob(prepareBindings(bytes, d, rest));
}

/**
 * {@link unpackBindings} in blocks, letting frames draw between them. The same bytes.
 *
 * @param bytes The packed file.
 * @param d The package's descriptor.
 * @param rest The head's rest vertices in the character's frame.
 * @param pause Awaited between blocks.
 * @returns The plain file's bytes.
 */
export function unpackBindingsAsync(
  bytes: Uint8Array,
  d: Pick<AosrigSplatDescriptor, 'splatCount' | 'headVertexCount' | 'jointNames'>,
  rest: ArrayLike<number>,
  pause: () => Promise<void>,
): Promise<Uint8Array> {
  return runJobAsync(prepareBindings(bytes, d, rest), pause);
}

/**
 * A pause that waits for a frame only once `ms` of work has gone by since the last one, so a long
 * job keeps frames coming without waiting a frame per block.
 *
 * @param nextFrame Resolves on the next frame.
 * @param ms Work allowed between frames.
 * @returns The pause.
 */
export function frameBudget(nextFrame: () => Promise<void>, ms = 6): () => Promise<void> {
  let last = performance.now();
  return async () => {
    if (performance.now() - last < ms) return;
    await nextFrame();
    last = performance.now();
  };
}

/**
 * A pause for a character's load and build (the loader's and `createAosrigSplat`'s `pause`):
 * once `ms` of work has gone by, it gives the page back for a moment (a message-channel task,
 * so a frame that is due draws, and a hidden tab, whose frames and timers are held back, still
 * loads at full speed). The app's own scene keeps drawing while a character is unpacked and built.
 *
 * @param ms Work allowed between yields.
 * @returns The pause.
 * @example
 * ```ts
 * const pause = yieldingPause();
 * const bundle = await loadAosrigSplatBundle(url, signal, { pause });
 * ```
 */
export function yieldingPause(ms = 8): () => Promise<void> {
  const channel = typeof MessageChannel === 'undefined' ? null : new MessageChannel();
  const waiting: (() => void)[] = [];
  if (channel)
    channel.port1.onmessage = () => {
      waiting.shift()?.();
    };
  return frameBudget(
    () =>
      new Promise<void>((resolve) => {
        if (!channel) {
          setTimeout(resolve, 0);
          return;
        }
        waiting.push(resolve);
        channel.port2.postMessage(0);
      }),
    ms,
  );
}
