/**
 * An exported character's splat deformation as a TSL compute node: each gaussian bound to the
 * head's triangles and the body's joints, on WebGPU and on the WebGL2 fallback from one source.
 *
 * The shape of it is about what the fallback can do. There a TSL compute runs as transform
 * feedback: every storage node it reads is a PBO texture, each invocation writes exactly its own
 * element of each output, and four outputs is the limit (the sink's four buffers). So:
 *
 * - The 44-float record (`packGaussianChunk`) is split in two: nine `vec4`s of floats and three
 *   `uvec4`s of integers. The record keeps joint and face indices as the raw bits of float lanes;
 *   small integers as float bits are denormals, and a GPU may flush those to zero on a texture
 *   read. `splitBoundRecords` does the split.
 * - On WebGL one dispatch covers the whole sink (`storageCapacity`), and invocation `i` writes
 *   slot `i`: slots outside the character's range are written invisible (colour 0). On WebGPU
 *   the dispatch covers the character's own slots and writes at `offset + i`.
 * - The Jacobian is carried as three column vectors and the covariance is built entry by entry,
 *   so nothing depends on how either shading language indexes a matrix.
 */
import {
  Fn,
  If,
  clamp,
  cross,
  dot,
  float,
  floor,
  instanceIndex,
  length,
  max,
  min,
  mix,
  normalize,
  select,
  smoothstep,
  storage,
  uint,
  uniform,
  uniformArray,
  vec3,
  vec4,
} from 'three/tsl';
import { primeTextureReads } from '../rig/gnm/gnmNode.js';
import {
  Matrix4,
  StorageInstancedBufferAttribute,
  Vector4,
  type ComputeNode,
  type Node,
  type StorageBufferNode,
} from 'three/webgpu';

/** Floats per gaussian in the float half of a split record. */
export const BOUND_FLOAT_VEC4S = 9;
/** `uvec4`s per gaussian in the integer half of a split record. */
export const BOUND_UINT_VEC4S = 3;
/** Floats in one record as `packGaussianChunk` writes it. */
const RECORD_FLOATS = 44;
/** Joints the bone uniform holds. */
export const MAX_BONES = 128;
/** A face splat's stretch with its triangle is kept within this of its rest size (each axis). */
const STRETCH_MAX = 1.5;
const STRETCH_MIN = 1 / 1.5;

/** Real-SH basis constants. */
const SH_C = [
  0.4886025119, 1.0925484306, 0.3153915653, 0.5462742153, 0.5900435899, 2.8906114426, 0.4570457995,
  0.3731763326, 1.4453057213,
];

/** A record split for the node: nine `vec4`s and three `uvec4`s per gaussian. */
export interface SplitBoundRecords {
  /**
   * Per gaussian: center, covA, covB, color, weights, inv0 (w = the face blend), inv1, inv2,
   * origin, each `xyzw` except where noted; the w lanes that held integer bits are 0.
   */
  readonly floats: Float32Array;
  /**
   * Per gaussian: the four joints; the face's three vertices and the hidden kind; the upper and
   * lower lip vertex and the band index (then 0).
   */
  readonly uints: Uint32Array;
}

/**
 * Split `packGaussianChunk` records (44 floats each, integer lanes as raw bits) into the node's
 * float and integer inputs.
 *
 * @param records The records, lanes already written (`ownLanes`, `hiddenLanes`, `newLanes`).
 * @param count Gaussians in `records`.
 * @param out Where to write, sized for at least `count`; allocated when omitted.
 * @param at First gaussian of `out` to write.
 * @returns `out`.
 * @example
 * ```ts
 * const split = splitBoundRecords(records, count);
 * ```
 */
export function splitBoundRecords(
  records: Float32Array,
  count: number,
  out: SplitBoundRecords = {
    floats: new Float32Array(count * BOUND_FLOAT_VEC4S * 4),
    uints: new Uint32Array(count * BOUND_UINT_VEC4S * 4),
  },
  at = 0,
): SplitBoundRecords {
  const bits = new Uint32Array(records.buffer, records.byteOffset, count * RECORD_FLOATS);
  const { floats, uints } = out;
  for (let n = 0; n < count; n++) {
    const r = n * RECORD_FLOATS;
    const f = (at + n) * BOUND_FLOAT_VEC4S * 4;
    const u = (at + n) * BOUND_UINT_VEC4S * 4;
    // center, covA, covB, color: floats 0..15 as they are
    floats.set(records.subarray(r, r + 16), f);
    // weights (20..23)
    floats.set(records.subarray(r + 20, r + 24), f + 16);
    // inv0.xyz, then the face blend (face.w, a float kept as bits)
    floats.set(records.subarray(r + 28, r + 31), f + 20);
    floats[f + 23] = records[r + 27] ?? 0;
    // inv1.xyz, inv2.xyz, origin.xyz; their w lanes are integers, moved below
    floats.set(records.subarray(r + 32, r + 35), f + 24);
    floats[f + 27] = 0;
    floats.set(records.subarray(r + 36, r + 39), f + 28);
    floats[f + 31] = 0;
    floats.set(records.subarray(r + 40, r + 43), f + 32);
    floats[f + 35] = 0;
    // joints (16..19)
    uints.set(bits.subarray(r + 16, r + 20), u);
    // face vertices (24..26) and the hidden kind (inv0.w, 31)
    uints.set(bits.subarray(r + 24, r + 27), u + 4);
    uints[u + 7] = bits[r + 31] ?? 0;
    // upper lip vertex (inv1.w), lower (inv2.w), band index (origin.w)
    uints[u + 8] = bits[r + 35] ?? 0;
    uints[u + 9] = bits[r + 39] ?? 0;
    uints[u + 10] = bits[r + 43] ?? 0;
    uints[u + 11] = 0;
  }
  return out;
}

/**
 * The node's inputs for one character, filled chunk by chunk as the chunks are packed, so a
 * chunk's 44-float records can go as soon as they are added: the records split in two, and one
 * float buffer holding the head at rest and the band shapes, then the harmonics (channel-major,
 * `shCount` a gaussian).
 */
export interface BoundInputs extends SplitBoundRecords {
  /** Gaussians. */
  readonly count: number;
  /** Harmonics per gaussian: the widest of the chunks'; a narrower chunk's are copied in. */
  readonly shCount: number;
  /** The head at rest and the band shapes (the first `shAt` floats), then the harmonics. */
  readonly extra: Float32Array;
  /** Where the harmonics start in `extra`. */
  readonly shAt: number;
  /**
   * Add a packed chunk (`packGaussianChunk`, lanes written) at gaussian `at`.
   *
   * @param records Its 44-float records.
   * @param sh Its harmonics, `chunkSh` a gaussian.
   * @param chunkSh Its harmonics count (0 for none).
   * @param count Its gaussians.
   * @param at Its first gaussian among the character's.
   * @returns Nothing.
   */
  add(records: Float32Array, sh: Float32Array, chunkSh: number, count: number, at: number): void;
}

/**
 * Allocate a character's inputs for {@link createBoundSplatNode}.
 *
 * @param count The character's gaussians (its corrections' new ones included).
 * @param shCount Harmonics per gaussian, the widest any chunk will bring.
 * @param aux The head at rest (xyz per vertex), then the band splats' shapes.
 * @returns The inputs, to `add` every chunk to.
 * @example
 * ```ts
 * const inputs = createBoundInputs(count, ply.shCount, aux);
 * inputs.add(records, sh, shCount, chunkCount, 0);
 * ```
 */
export function createBoundInputs(count: number, shCount: number, aux: Float32Array): BoundInputs {
  const floats = new Float32Array(count * BOUND_FLOAT_VEC4S * 4);
  const uints = new Uint32Array(count * BOUND_UINT_VEC4S * 4);
  const shAt = aux.length;
  const extra = new Float32Array(Math.max(1, shAt + count * shCount));
  extra.set(aux);
  const perChannel = shCount / 3;
  return {
    floats,
    uints,
    count,
    shCount,
    extra,
    shAt,
    add(records, sh, chunkSh, n, at) {
      splitBoundRecords(records, n, { floats, uints }, at);
      if (chunkSh === 0) return;
      if (chunkSh > shCount)
        throw new Error('aosrig-splat: a chunk brings more harmonics than allocated');
      const pc = chunkSh / 3;
      for (let i = 0; i < n; i++)
        for (let ch = 0; ch < 3; ch++)
          for (let k = 0; k < pc; k++)
            extra[shAt + (at + i) * shCount + ch * perChannel + k] =
              sh[i * chunkSh + ch * pc + k] ?? 0;
    },
  };
}

/** The storage nodes a producer writes, as `@gameable/splat`'s `SplatStorageNodes`. */
export interface BoundSplatOutputs {
  readonly center: StorageBufferNode<'vec4'>;
  readonly covarianceA: StorageBufferNode<'vec4'>;
  readonly covarianceB: StorageBufferNode<'vec4'>;
  readonly color: StorageBufferNode<'uint'>;
}

/** Everything the node reads that is fixed once the character is built. */
export interface BoundSplatNodeOptions {
  /** Every gaussian the character draws, in slot order (`createBoundInputs`, every chunk added). */
  readonly inputs: BoundInputs;
  /** First slot of the character in the sink. */
  readonly offset: number;
  /**
   * The skeleton's joints (at most `MAX_BONES`): the bone uniform holds this many matrices, no
   * more (a WebGL2 vertex stage is only sure of 256 uniform vectors, four a matrix).
   */
  readonly joints: number;
  /** Where the band shapes start in `inputs.extra`, in floats. */
  readonly bandAt: number;
  /** The posed head, one `vec4` per vertex (xyz, w = 1), written by the head pass (`gnmNode.ts`). */
  readonly head: StorageBufferNode<'vec4'>;
  /** The sink's four buffers. */
  readonly outputs: BoundSplatOutputs;
  /** The sink's padded element count: the dispatch on WebGL. */
  readonly storageCapacity: number;
  /** True on the WebGL2 fallback: PBO inputs and one dispatch over the whole sink. */
  readonly webgl: boolean;
}

/** The node and the per-frame values it reads. */
export interface BoundSplatNode {
  /** Dispatch with `renderer.compute(node.compute)` once per frame, after the head pass. */
  readonly compute: ComputeNode;
  /** Camera position in the sink's local space (w unused). */
  readonly camera: Vector4;
  /** The four pose-correction weights. */
  readonly weights: Vector4;
  /** The head's up; w is 1 while the closed mouth's inside points play. */
  readonly up: Vector4;
  /** The head's forward; w is 1 while the lips' band's size cap is on. */
  readonly forward: Vector4;
  /**
   * Copy the skin matrices (16 floats per joint, column-major) into the bone uniform.
   *
   * @param matrices 16 floats per joint, at least `joints` of them.
   * @returns Nothing.
   */
  setBones(matrices: Float32Array): void;
  /** The input attributes, for the owner to release. */
  readonly attributes: readonly StorageInstancedBufferAttribute[];
}

/**
 * Build the deformation node for one character.
 *
 * @param o The character's fixed inputs and the sink's outputs.
 * @returns The node and its per-frame values.
 * @example
 * ```ts
 * const bound = createBoundSplatNode({ inputs, offset: range.offset, joints, bandAt, head,
 *   outputs: sink.nodes, storageCapacity: sink.storageCapacity, webgl });
 * bound.setBones(matrices);
 * renderer.compute(bound.compute);
 * ```
 */
export function createBoundSplatNode(o: BoundSplatNodeOptions): BoundSplatNode {
  const { offset, webgl } = o;
  const { count, shCount, shAt } = o.inputs;
  const attributes: StorageInstancedBufferAttribute[] = [];
  const input = <T extends 'vec4' | 'uvec4' | 'float'>(
    array: Float32Array | Uint32Array,
    itemSize: number,
    type: T,
  ): StorageBufferNode<T> => {
    const attribute = new StorageInstancedBufferAttribute(array, itemSize);
    attributes.push(attribute);
    const node = storage(attribute, type, array.length / itemSize).toReadOnly();
    if (webgl) node.setPBO(true);
    return node as unknown as StorageBufferNode<T>;
  };
  const floats = input(o.inputs.floats, 4, 'vec4');
  const uints = input(o.inputs.uints, 4, 'uvec4');
  // The head at rest and the band shapes, then the harmonics, in one buffer: with the records' two,
  // the head pass's output and the sink's four, the node binds eight storage buffers, the most a
  // WebGPU device allows a page that asks for no limits.
  const aux = input(o.inputs.extra, 1, 'float');
  const harmonics = aux;
  const head = o.head;

  const cameraValue = new Vector4(),
    weightsValue = new Vector4(),
    upValue = new Vector4(),
    forwardValue = new Vector4();
  const camera = uniform(cameraValue),
    weights = uniform(weightsValue),
    up = uniform(upValue),
    forward = uniform(forwardValue);
  const boneValues = Array.from(
    { length: Math.max(1, Math.min(MAX_BONES, o.joints)) },
    () => new Matrix4(),
  );
  const bones = uniformArray<'mat4'>(boneValues, 'mat4');

  const perChannel = Math.floor(shCount / 3);
  const bandAt = o.bandAt;

  const deform = Fn(() => {
    // head and aux are first read inside branches (the closed mouth's, a face splat's).
    primeTextureReads(webgl, head, aux);
    const i = instanceIndex;
    // WebGL: invocation i is slot i, and the character's own slots are [offset, offset+count).
    const inRange = webgl
      ? i.greaterThanEqual(uint(offset)).and(i.lessThan(uint(offset + count)))
      : i.lessThan(uint(count));
    const local = (webgl ? select(inRange, i.sub(uint(offset)), uint(0)) : i).toVar('local');

    const F = (k: number): Node<'vec4'> => floats.element(local.mul(BOUND_FLOAT_VEC4S).add(k));
    const U = (k: number): Node<'uvec4'> => uints.element(local.mul(BOUND_UINT_VEC4S).add(k));
    const center = vec4(F(0)).toVar('center');
    const covA = vec4(F(1)).toVar('covA');
    const covB = vec4(F(2)).toVar('covB');
    const color = vec4(F(3)).toVar('color');
    const bw = vec4(F(4)).toVar('boneWeights');
    const inv0 = vec4(F(5)).toVar('inv0');
    const inv1 = vec4(F(6)).toVar('inv1');
    const inv2 = vec4(F(7)).toVar('inv2');
    const origin = vec4(F(8)).toVar('origin');
    const joints = U(0).toVar('joints');
    const faceU = U(1).toVar('faceU');
    const lanes = U(2).toVar('lanes');

    const vertex = (v: Node<'uint'>): Node<'vec3'> => vec4(head.element(v)).xyz;
    const vertexRest = (v: Node<'uint'>): Node<'vec3'> =>
      vec3(aux.element(v.mul(3)), aux.element(v.mul(3).add(1)), aux.element(v.mul(3).add(2)));
    const bandShape = (k: Node<'uint'>): Node<'vec4'> => {
      const at = uint(bandAt).add(k.mul(4));
      return vec4(
        aux.element(at),
        aux.element(at.add(1)),
        aux.element(at.add(2)),
        aux.element(at.add(3)),
      );
    };

    // The Jacobian's columns, identity to start.
    const j0 = vec3(1, 0, 0).toVar('j0');
    const j1 = vec3(0, 1, 0).toVar('j1');
    const j2 = vec3(0, 0, 1).toVar('j2');
    const p = center.xyz.toVar('p');
    const blend = inv0.w;

    // The closed mouth's inside (mouthHidden.ts HIDDEN_LANE).
    const hiddenKind = select(up.w.greaterThan(0.5), faceU.w, uint(0)).toVar('hiddenKind');
    const hide = float(0).toVar('hide');
    const band = float(0).toVar('band');
    If(hiddenKind.greaterThan(uint(0)), () => {
      const du = vertex(lanes.x).sub(vertexRest(lanes.x)).toVar('du');
      const dl = vertex(lanes.y).sub(vertexRest(lanes.y)).toVar('dl');
      const gap = max(0, dot(du.sub(dl), up.xyz)).toVar('gap');
      const ramp = smoothstep(0.0005, 0.002, gap).toVar('ramp');
      hide.assign(select(hiddenKind.equal(uint(3)), float(0), ramp));
      band.assign(
        select(hiddenKind.equal(uint(3)).and(forward.w.greaterThan(0.5)), ramp, float(0)),
      );
      If(hiddenKind.equal(uint(1)), () => {
        const push = float(0.003)
          .mul(smoothstep(0, 0.002, gap))
          .add(float(0.25).mul(min(gap, 0.03)));
        p.assign(p.add(du.add(dl).mul(0.5)).sub(forward.xyz.mul(push)));
      });
    });

    If(blend.greaterThan(0).and(hiddenKind.notEqual(uint(1))), () => {
      const a = vertex(faceU.x).toVar('a');
      const e1 = vertex(faceU.y).sub(a).toVar('e1');
      const e2 = vertex(faceU.z).sub(a).toVar('e2');
      const n = cross(e1, e2).toVar('n');
      const area = length(n).toVar('area');
      If(area.greaterThan(1e-10), () => {
        const nn = n.div(area).toVar('nn');
        // f = mat3(e1, e2, nn) * transpose(mat3(inv0, inv1, inv2)); column k is
        // e1 * inv0[k] + e2 * inv1[k] + nn * inv2[k].
        const fc = (k: 'x' | 'y' | 'z'): Node<'vec3'> =>
          e1.mul(inv0[k]).add(e2.mul(inv1[k])).add(nn.mul(inv2[k]));
        const f0 = fc('x').toVar('f0');
        const f1 = fc('y').toVar('f1');
        const f2 = fc('z').toVar('f2');
        const d = p.sub(origin.xyz).toVar('d');
        const moved = a.add(f0.mul(d.x)).add(f1.mul(d.y)).add(f2.mul(d.z));
        p.assign(mix(p, moved, blend));
        // the turn and a capped stretch, never the shear
        const s0 = length(f0).toVar('s0');
        const r0 = f0.div(max(s0, 1e-9)).toVar('r0');
        const u1 = f1.sub(r0.mul(dot(f1, r0))).toVar('u1');
        const s1 = length(u1).toVar('s1');
        const r1 = u1.div(max(s1, 1e-9)).toVar('r1');
        const r2 = cross(r0, r1).toVar('r2');
        const s2 = dot(f2, r2).abs();
        const oneMinus = float(1).sub(blend);
        j0.assign(
          vec3(1, 0, 0)
            .mul(oneMinus)
            .add(r0.mul(clamp(s0, STRETCH_MIN, STRETCH_MAX).mul(blend))),
        );
        j1.assign(
          vec3(0, 1, 0)
            .mul(oneMinus)
            .add(r1.mul(clamp(s1, STRETCH_MIN, STRETCH_MAX).mul(blend))),
        );
        j2.assign(
          vec3(0, 0, 1)
            .mul(oneMinus)
            .add(r2.mul(clamp(s2, STRETCH_MIN, STRETCH_MAX).mul(blend))),
        );
      });
    });

    // Linear blend skinning.
    const skin = bones
      .element(joints.x)
      .mul(bw.x)
      .add(bones.element(joints.y).mul(bw.y))
      .add(bones.element(joints.z).mul(bw.z))
      .add(bones.element(joints.w).mul(bw.w))
      .toVar('skin');
    p.assign(skin.mul(vec4(p, 1)).xyz);
    j0.assign(skin.mul(vec4(j0, 0)).xyz);
    j1.assign(skin.mul(vec4(j1, 0)).xyz);
    j2.assign(skin.mul(vec4(j2, 0)).xyz);

    // The rest covariance as three rows (symmetric), or a band splat's own turn and sizes.
    const c0 = vec3(covA.x, covA.y, covA.z).toVar('sigma0');
    const c1 = vec3(covA.y, covA.w, covB.x).toVar('sigma1');
    const c2 = vec3(covA.z, covB.x, covB.y).toVar('sigma2');
    const bandIndex = lanes.z;
    If(band.greaterThan(0).and(bandIndex.greaterThan(uint(0))), () => {
      const k = bandIndex.sub(uint(1)).mul(2);
      const q = bandShape(k).toVar('q');
      const sRest = bandShape(k.add(1)).xyz.toVar('sRest');
      const s = mix(sRest, min(sRest, vec3(0.0025)), band).toVar('s');
      const w = q.x,
        x = q.y,
        y = q.z,
        z = q.w;
      // R's columns
      const ra = vec3(
        float(1).sub(y.mul(y).add(z.mul(z)).mul(2)),
        x.mul(y).add(z.mul(w)).mul(2),
        x.mul(z).sub(y.mul(w)).mul(2),
      ).toVar('ra');
      const rb = vec3(
        x.mul(y).sub(z.mul(w)).mul(2),
        float(1).sub(x.mul(x).add(z.mul(z)).mul(2)),
        y.mul(z).add(x.mul(w)).mul(2),
      ).toVar('rb');
      const rc = vec3(
        x.mul(z).add(y.mul(w)).mul(2),
        y.mul(z).sub(x.mul(w)).mul(2),
        float(1).sub(x.mul(x).add(y.mul(y)).mul(2)),
      ).toVar('rc');
      // R diag(s^2) R^T = sum_k s_k^2 col_k col_k^T; row a is sum_k s_k^2 col_k[a] col_k
      const ss = s.mul(s);
      const row = (axis: 'x' | 'y' | 'z'): Node<'vec3'> =>
        ra
          .mul(ss.x.mul(ra[axis]))
          .add(rb.mul(ss.y.mul(rb[axis])))
          .add(rc.mul(ss.z.mul(rc[axis])));
      c0.assign(row('x'));
      c1.assign(row('y'));
      c2.assign(row('z'));
    });

    // c = J Sigma J^T, from J's rows.
    const jr0 = vec3(j0.x, j1.x, j2.x).toVar('jr0');
    const jr1 = vec3(j0.y, j1.y, j2.y).toVar('jr1');
    const jr2 = vec3(j0.z, j1.z, j2.z).toVar('jr2');
    const sigma = (v: Node<'vec3'>): Node<'vec3'> => vec3(dot(c0, v), dot(c1, v), dot(c2, v));
    const t0 = sigma(jr0).toVar('t0');
    const t1 = sigma(jr1).toVar('t1');
    const t2 = sigma(jr2).toVar('t2');

    // Colour: the view direction in the joint frame, orthonormalised.
    const rgb = color.xyz.toVar('rgb');
    if (perChannel > 0) {
      const rx = normalize(j0).toVar('rx');
      const rz = normalize(cross(rx, j1)).toVar('rz');
      const ry = cross(rz, rx).toVar('ry');
      const v = p.sub(camera.xyz).toVar('toSplat');
      const dir = normalize(vec3(dot(rx, v), dot(ry, v), dot(rz, v))).toVar('dir');
      const { x, y, z } = { x: dir.x, y: dir.y, z: dir.z };
      const basis: Node<'float'>[] = [
        y.mul(-SH_C[0]),
        z.mul(SH_C[0]),
        x.mul(-SH_C[0]),
        x.mul(y).mul(SH_C[1]),
        y.mul(z).mul(-SH_C[1]),
        z.mul(z).mul(2).sub(x.mul(x)).sub(y.mul(y)).mul(SH_C[2]),
        x.mul(z).mul(-SH_C[1]),
        x.mul(x).sub(y.mul(y)).mul(SH_C[3]),
        y.mul(x.mul(x).mul(3).sub(y.mul(y))).mul(-SH_C[4]),
        x.mul(y).mul(z).mul(SH_C[5]),
        y.mul(z.mul(z).mul(4).sub(x.mul(x)).sub(y.mul(y))).mul(-SH_C[6]),
        z.mul(z.mul(z).mul(2).sub(x.mul(x).mul(3)).sub(y.mul(y).mul(3))).mul(SH_C[7]),
        x.mul(z.mul(z).mul(4).sub(x.mul(x)).sub(y.mul(y))).mul(-SH_C[6]),
        z.mul(x.mul(x).sub(y.mul(y))).mul(SH_C[8]),
        x.mul(x.mul(x).sub(y.mul(y).mul(3))).mul(-SH_C[4]),
      ];
      const base = local.mul(shCount).add(shAt).toVar('shBase');
      for (let k = 0; k < perChannel; k++) {
        const b = basis[k];
        rgb.addAssign(
          vec3(
            harmonics.element(base.add(k)),
            harmonics.element(base.add(perChannel + k)),
            harmonics.element(base.add(2 * perChannel + k)),
          ).mul(b),
        );
      }
    }

    // A pose correction (corrective.ts LANE) and the hidden points' fade.
    const slot = uint(clamp(covB.z, 0, 3)).toVar('slot');
    const cw = select(
      slot.greaterThanEqual(uint(2)),
      select(slot.equal(uint(3)), weights.w, weights.z),
      select(slot.equal(uint(1)), weights.y, weights.x),
    ).toVar('correction');
    const alpha = select(
      covB.w.greaterThan(0.5),
      color.w.mul(cw),
      color.w.mul(mix(float(1), center.w, cw)),
    )
      .mul(float(1).sub(hide))
      .toVar('alpha');

    // pack4x8unorm by hand: GLSL ES 3.00 has no packUnorm4x8.
    const byte = (v: Node<'float'>): Node<'uint'> => uint(floor(clamp(v, 0, 1).mul(255).add(0.5)));
    const packed = byte(rgb.x)
      .bitOr(byte(rgb.y).shiftLeft(uint(8)))
      .bitOr(byte(rgb.z).shiftLeft(uint(16)))
      .bitOr(byte(alpha).shiftLeft(uint(24)));

    const outCenter = vec4(p, 1);
    const outCovA = vec4(dot(jr0, t0), dot(jr0, t1), dot(jr0, t2), dot(jr1, t1));
    const outCovB = vec4(dot(jr1, t2), dot(jr2, t2), 0, 0);
    if (webgl) {
      // Every output written by every invocation: slots outside the character are invisible.
      o.outputs.center.element(i).assign(select(inRange, outCenter, vec4(0)));
      o.outputs.covarianceA.element(i).assign(select(inRange, outCovA, vec4(0)));
      o.outputs.covarianceB.element(i).assign(select(inRange, outCovB, vec4(0)));
      o.outputs.color.element(i).assign(select(inRange, packed, uint(0)));
    } else {
      If(inRange, () => {
        const out = i.add(uint(offset));
        o.outputs.center.element(out).assign(outCenter);
        o.outputs.covarianceA.element(out).assign(outCovA);
        o.outputs.covarianceB.element(out).assign(outCovB);
        o.outputs.color.element(out).assign(packed);
      });
    }
  });

  const compute = deform().compute(webgl ? o.storageCapacity : count, [64]);

  return {
    compute,
    camera: cameraValue,
    weights: weightsValue,
    up: upValue,
    forward: forwardValue,
    setBones(matrices) {
      const joints = Math.min(boneValues.length, Math.floor(matrices.length / 16));
      for (let j = 0; j < joints; j++) boneValues[j]?.fromArray(matrices, j * 16);
    },
    attributes,
  };
}
