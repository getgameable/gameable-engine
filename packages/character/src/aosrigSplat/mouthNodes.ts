/**
 * The mouth's two GPU passes as TSL compute nodes, so the inside of the mouth draws on WebGPU
 * and on the WebGL2 fallback from one source. They read the head pass's output (`gnmNode.ts`, a
 * `vec4` per vertex).
 *
 * What the fallback asks for, as in `boundSplatNode.ts`: there a compute is transform feedback,
 * so every input is a PBO texture and each invocation writes exactly its own element of each
 * output.
 *
 * - The teeth: on WebGL one dispatch covers the teeth's whole sink, and slots outside their range
 *   are written invisible; on WebGPU the dispatch covers the points and writes at `offset + i`.
 * - The mesh: two `vec4`s per vertex (position and shade, then the normal). Invocation `j` writes
 *   element `j`: vertex `j >> 1`, its position when `j` is even and its normal when odd.
 * - The head joint comes as the three rows of its 3x4 affine, and the covariance is built entry
 *   by entry, so nothing depends on how either shading language indexes a matrix.
 */
import {
  Fn,
  If,
  Loop,
  clamp,
  cross,
  dot,
  floor,
  instanceIndex,
  length,
  max,
  normalize,
  select,
  storage,
  uint,
  uniform,
  vec3,
  vec4,
} from 'three/tsl';
import {
  StorageInstancedBufferAttribute,
  Vector4,
  type ComputeNode,
  type Node,
  type StorageBufferNode,
} from 'three/webgpu';
import { padTextureShape, primeTextureReads } from '../rig/gnm/gnmNode.js';

/** The posed head, as the head pass leaves it. */
export interface MouthHeadInput {
  /** `vec4` per vertex (xyz, w = 1). */
  readonly attribute: StorageInstancedBufferAttribute;
  /** Its element count (vertices, padded on WebGL). */
  readonly capacity: number;
}

/** The head joint's skin matrix, as three uniform rows. */
interface JointRows {
  readonly rows: readonly [Vector4, Vector4, Vector4];
  /**
   * Take the joint's skin matrix.
   *
   * @param skin Column-major 4x4.
   * @returns Nothing.
   */
  set(skin: ArrayLike<number>): void;
}

function jointRows(): JointRows {
  const rows = [new Vector4(1, 0, 0, 0), new Vector4(0, 1, 0, 0), new Vector4(0, 0, 1, 0)] as const;
  return {
    rows,
    set(skin) {
      for (let r = 0; r < 3; r++) rows[r].set(skin[r], skin[4 + r], skin[8 + r], skin[12 + r]);
    },
  };
}

/** A mouth pass as a node, and what it reads each frame. */
export interface MouthPassNode {
  /** Dispatch with `renderer.compute`, after the head pass. */
  readonly compute: ComputeNode;
  /**
   * Take this frame's head joint.
   *
   * @param skin The head joint's skin matrix, column-major 4x4.
   * @returns Nothing.
   */
  setSkin(skin: ArrayLike<number>): void;
  /** The input attributes, for the owner to release. */
  readonly attributes: readonly StorageInstancedBufferAttribute[];
}

/**
 * The teeth's points: each moved with the head triangle it is bound to, then by the head joint.
 *
 * @param o The points (24 lanes each, as `mouthRuntime.ts` packs them), the head, the teeth
 *   sink's nodes and range.
 * @param o.points 24 floats per point: tri (u32 bits) + pad, bary + height, offset, covA, covB, colour.
 * @param o.count Points.
 * @param o.offset First slot in the sink.
 * @param o.head The posed head.
 * @param o.outputs The teeth sink's storage nodes (`'rgba8'` colour).
 * @param o.storageCapacity The teeth sink's padded element count: the dispatch on WebGL.
 * @param o.webgl True on the WebGL2 fallback.
 * @returns The node.
 * @example
 * ```ts
 * const teeth = createTeethNode({ points, count: n, offset: range.offset, head,
 *   outputs: sink.nodes, storageCapacity: sink.storageCapacity, webgl });
 * teeth.setSkin(headSkin);
 * renderer.compute(teeth.compute);
 * ```
 */
export function createTeethNode(o: {
  readonly points: Float32Array;
  readonly count: number;
  readonly offset: number;
  readonly head: MouthHeadInput;
  readonly outputs: {
    readonly center: StorageBufferNode<'vec4'>;
    readonly covarianceA: StorageBufferNode<'vec4'>;
    readonly covarianceB: StorageBufferNode<'vec4'>;
    readonly color: StorageBufferNode<'uint'>;
  };
  readonly storageCapacity: number;
  readonly webgl: boolean;
}): MouthPassNode {
  const { count, offset, webgl } = o;
  const floats = new Float32Array(count * 20);
  const tris = new Uint32Array(count * 4);
  const bits = new Uint32Array(o.points.buffer, o.points.byteOffset, o.points.length);
  for (let i = 0; i < count; i++) {
    tris.set(bits.subarray(i * 24, i * 24 + 3), i * 4);
    floats.set(o.points.subarray(i * 24 + 4, i * 24 + 24), i * 20);
  }
  const attributes: StorageInstancedBufferAttribute[] = [];
  const input = <T extends 'vec4' | 'uvec4'>(
    array: Float32Array | Uint32Array,
    type: T,
  ): StorageBufferNode<T> => {
    const attribute = new StorageInstancedBufferAttribute(array, 4);
    attributes.push(attribute);
    const node = storage(attribute, type, array.length / 4).toReadOnly();
    if (webgl) node.setPBO(true);
    return node as unknown as StorageBufferNode<T>;
  };
  const F = input(floats, 'vec4');
  const T = input(tris, 'uvec4');
  const head = storage(o.head.attribute, 'vec4', o.head.capacity).toReadOnly();
  if (webgl) head.setPBO(true);
  const joint = jointRows();
  const [rx, ry, rz] = joint.rows.map((r) => uniform(r));

  const place = Fn(() => {
    primeTextureReads(webgl, head, F, T);
    const i = instanceIndex;
    const inRange = webgl
      ? i.greaterThanEqual(uint(offset)).and(i.lessThan(uint(offset + count)))
      : i.lessThan(uint(count));
    const local = (webgl ? select(inRange, i.sub(uint(offset)), uint(0)) : i).toVar('local');
    const at = (k: number): Node<'vec4'> => vec4(F.element(local.mul(uint(5)).add(uint(k))));
    const tri = T.element(local).toVar('tri');
    const a = head.element(tri.x).xyz.toVar('a');
    const b = head.element(tri.y).xyz.toVar('b');
    const c = head.element(tri.z).xyz.toVar('c');
    const n = cross(b.sub(a), c.sub(a)).toVar('n');
    const area = length(n);
    const unit = select(area.greaterThan(1e-12), n.div(max(area, 1e-30)), vec3(0));
    const bary = at(0).toVar('bary');
    const off = at(1).toVar('offset');
    const covA = at(2).toVar('covA');
    const covB = at(3).toVar('covB');
    const color = at(4).toVar('color');
    const q = a
      .mul(bary.x)
      .add(b.mul(bary.y))
      .add(c.mul(bary.z))
      .add(unit.mul(bary.w))
      .add(off.xyz)
      .toVar('q');
    const p = vec3(dot(rx.xyz, q).add(rx.w), dot(ry.xyz, q).add(ry.w), dot(rz.xyz, q).add(rz.w));
    // R C R^T entry by entry, from R's rows and C's (symmetric) columns.
    const c0 = vec3(covA.x, covA.y, covA.z),
      c1 = vec3(covA.y, covA.w, covB.x),
      c2 = vec3(covA.z, covB.x, covB.y);
    const times = (v: Node<'vec3'>): Node<'vec3'> => vec3(dot(c0, v), dot(c1, v), dot(c2, v));
    const cx = times(rx.xyz).toVar('cx'),
      cy = times(ry.xyz).toVar('cy'),
      cz = times(rz.xyz).toVar('cz');
    const outCenter = vec4(p, 1);
    const outCovA = vec4(dot(rx.xyz, cx), dot(rx.xyz, cy), dot(rx.xyz, cz), dot(ry.xyz, cy));
    const outCovB = vec4(dot(ry.xyz, cz), dot(rz.xyz, cz), 0, 0);
    // pack4x8unorm by hand: GLSL ES 3.00 has no packUnorm4x8.
    const byte = (v: Node<'float'>): Node<'uint'> => uint(floor(clamp(v, 0, 1).mul(255).add(0.5)));
    const packed = byte(color.x)
      .bitOr(byte(color.y).shiftLeft(uint(8)))
      .bitOr(byte(color.z).shiftLeft(uint(16)))
      .bitOr(byte(color.w).shiftLeft(uint(24)));
    if (webgl) {
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

  return {
    compute: place().compute(webgl ? o.storageCapacity : count, [64]),
    setSkin: (skin) => {
      joint.set(skin);
    },
    attributes,
  };
}

/** The mesh pass, plus the buffer it writes (which the mesh's material reads). */
export interface MouthMeshNode extends MouthPassNode {
  /** Two `vec4`s per vertex: (position, shade), then (normal, 0). */
  readonly output: StorageInstancedBufferAttribute;
  /** The output's element count (`2 * vertices`, padded on WebGL). */
  readonly capacity: number;
}

/**
 * The mouth's mesh: each vertex at its head vertex, shifted, with its normal from the adjacent
 * triangles, moved by the head joint.
 *
 * @param o The mesh's vertices and adjacency, the shift, the head.
 * @param o.ids The head vertex behind each mesh vertex.
 * @param o.shade Each vertex's shade.
 * @param o.adjStart Where each vertex's triangles start in `adjTris` (vertices + 1 entries).
 * @param o.adjTris Three head vertices per adjacent triangle.
 * @param o.shift The mouth's shift (the set-back), metres.
 * @param o.head The posed head.
 * @param o.webgl True on the WebGL2 fallback.
 * @returns The node and its output.
 * @example
 * ```ts
 * const meshPass = createMouthMeshNode({ ids, shade, adjStart, adjTris, shift, head, webgl });
 * meshPass.setSkin(headSkin);
 * renderer.compute(meshPass.compute);
 * ```
 */
export function createMouthMeshNode(o: {
  readonly ids: ArrayLike<number>;
  readonly shade: ArrayLike<number>;
  readonly adjStart: Uint32Array;
  readonly adjTris: Uint32Array;
  readonly shift: readonly [number, number, number];
  readonly head: MouthHeadInput;
  readonly webgl: boolean;
}): MouthMeshNode {
  const { webgl } = o;
  const nv = o.ids.length;
  const capacity = webgl ? padTextureShape(nv * 2) : nv * 2;
  const perVertex = new Float32Array(nv * 4);
  const ids = new Uint32Array(Math.max(1, nv));
  for (let i = 0; i < nv; i++) {
    ids[i] = o.ids[i] ?? 0;
    for (let k = 0; k < 3; k++) perVertex[i * 4 + k] = o.shift[k];
    perVertex[i * 4 + 3] = o.shade[i] ?? 0;
  }
  const attributes: StorageInstancedBufferAttribute[] = [];
  const input = <T extends 'vec4' | 'uint'>(
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
  const vertexNode = input(perVertex, 4, 'vec4');
  const idNode = input(ids, 1, 'uint');
  const startNode = input(o.adjStart, 1, 'uint');
  const trisNode = input(o.adjTris.length > 0 ? o.adjTris : new Uint32Array(3), 1, 'uint');
  const head = storage(o.head.attribute, 'vec4', o.head.capacity).toReadOnly();
  if (webgl) head.setPBO(true);
  const output = new StorageInstancedBufferAttribute(new Float32Array(capacity * 4), 4);
  attributes.push(output);
  const out = storage(output, 'vec4', capacity);
  const joint = jointRows();
  const [rx, ry, rz] = joint.rows.map((r) => uniform(r));

  const build = Fn(() => {
    // Everything here is read inside one branch or the other.
    primeTextureReads(webgl, head, trisNode, startNode, vertexNode, idNode);
    const j = instanceIndex;
    const i = j.shiftRight(uint(1));
    const live = i.lessThan(uint(nv));
    const v = select(live, i, uint(0)).toVar('meshVertex');
    const odd = j.bitAnd(uint(1)).equal(uint(1));
    const vertex = (k: Node<'uint'>): Node<'vec3'> => head.element(trisNode.element(k)).xyz;
    const result = vec4(0).toVar('result');
    If(odd, () => {
      // the normal: summed over the vertex's part triangles (area-weighted), turned by the joint
      const n = vec3(0).toVar('n');
      const end = startNode.element(v.add(uint(1)));
      Loop(
        { start: startNode.element(v), end, type: 'uint', condition: '<' },
        ({ i: t }: { i: Node<'uint'> }) => {
          const a = vertex(t.mul(uint(3))).toVar('a');
          const b = vertex(t.mul(uint(3)).add(uint(1)));
          const c = vertex(t.mul(uint(3)).add(uint(2)));
          n.addAssign(cross(b.sub(a), c.sub(a)));
        },
      );
      const len = length(n);
      const unit = n.div(max(len, 1e-30));
      const turned = vec3(dot(rx.xyz, unit), dot(ry.xyz, unit), dot(rz.xyz, unit));
      const normal = select(len.greaterThan(1e-14), turned, vec3(0, 0, 1));
      result.assign(vec4(normalize(normal), 0));
    }).Else(() => {
      const pv = vertexNode.element(v).toVar('perVertex');
      const q = head.element(idNode.element(v)).xyz.add(pv.xyz).toVar('q');
      const p = vec3(dot(rx.xyz, q).add(rx.w), dot(ry.xyz, q).add(ry.w), dot(rz.xyz, q).add(rz.w));
      result.assign(vec4(p, pv.w));
    });
    if (webgl) {
      out.element(j).assign(select(live, result, vec4(0)));
    } else {
      If(live, () => {
        out.element(j).assign(result);
      });
    }
  });

  return {
    compute: build().compute(webgl ? capacity : nv * 2, [64]),
    setSkin: (skin) => {
      joint.set(skin);
    },
    attributes,
    output,
    capacity,
  };
}
