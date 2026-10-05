/**
 * `gnm_blend.wgsl` as a TSL compute node: the GNM head's expression blend, gaze, neck seam and
 * skinning, one invocation per vertex, on WebGPU and on the WebGL2 fallback.
 *
 * What changes against the WGSL, and why:
 *
 * - **Output: one `vec4` per vertex** (xyz, w = 1). On the fallback a compute is transform
 *   feedback, where invocation `v` can write only element `v`; three floats per vertex in a
 *   float array would be three elements. The array is padded to the PBO texture shape
 *   (`padTextureShape`, the same shape as the splat sink's `padStorageCapacity`) and one dispatch covers all of it; padded
 *   invocations write zeros.
 * - **No workgroup memory** on the fallback, so the coefficients (already multiplied by their
 *   fp16 dequantisation scales on the CPU) live in a `vec4` uniform array, and the blend walks
 *   it four coefficients at a time, unrolled, skipping zeros as the WGSL does.
 * - **Per-vertex inputs packed into `vec4`s** (neutral + left eye weight, seam + right eye
 *   weight, the four skin weights, the four skin joints as `uvec4`), to keep texture fetches
 *   down where every storage read is one.
 * - **The fp16 basis is read as it is packed**, two halves per `u32`: each coefficient's three
 *   halves span two words, unpacked with `unpackHalf2x16` (core in WGSL and GLSL ES 3.00).
 */
import {
  Fn,
  If,
  Loop,
  cross,
  dot,
  instanceIndex,
  select,
  storage,
  uint,
  uniform,
  uniformArray,
  unpackHalf2x16,
  vec2,
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

import type { AosRigPack } from './gnmPack.js';

/**
 * The PBO texture shape three's WebGL fallback reads a storage array through, as
 * `gameable/splat`'s `padStorageCapacity` (this package does not import that one).
 *
 * @param n Elements.
 * @returns `width * height` of the texture that holds `n`.
 * @example
 * ```ts
 * padTextureShape(17_821); // 17_920 = 256 x 70
 * ```
 */
export function padTextureShape(n: number): number {
  const width = Math.pow(2, Math.ceil(Math.log2(Math.sqrt(Math.max(1, n)))));
  return width * Math.ceil(n / width);
}

/**
 * Read element 0 of each PBO input once, at the top of a node's function, on the WebGL2
 * fallback. Call it first thing inside the `Fn`.
 *
 * three r186's GLSL builder (`GLSLNodeBuilder.generatePBO`) declares a PBO's texture width in the
 * flow where the buffer is first read, and every later read reuses it. When that first read sits
 * inside an `If`, a read in another branch (or after a skipped one) divides by a width that was
 * never set, and fetches nothing. Reading each buffer once up front sets the width for the whole
 * function. On WebGPU there is no PBO and this does nothing.
 *
 * @param webgl True on the WebGL2 fallback.
 * @param nodes The storage nodes the function reads through PBOs.
 * @returns Nothing.
 * @example
 * ```ts
 * const pass = Fn(() => {
 *   primeTextureReads(webgl, basis, head);
 *   // ... reads of basis and head inside If / Loop are now safe
 * });
 * ```
 */
export function primeTextureReads(
  webgl: boolean,
  ...nodes: readonly { element(index: Node<'uint'>): Node }[]
): void {
  if (!webgl) return;
  nodes.forEach((node, k) => {
    (node.element(uint(0)) as unknown as { toVar(name: string): Node }).toVar(
      `textureWidth${String(k)}`,
    );
  });
}

/** The head pass as a node, and what it reads each frame. */
export interface GnmNode {
  /** Dispatch before the deformation node, in the same `renderer.compute`. */
  readonly compute: ComputeNode;
  /**
   * The posed head, `vec4` per vertex (xyz, w = 1), `capacity` elements: for a later pass to read
   * (on WebGL through its PBO texture).
   */
  readonly outputAttribute: StorageInstancedBufferAttribute;
  /** The output's element count (vertices, padded on WebGL). */
  readonly capacity: number;
  /**
   * Take this frame's values (`GnmRigBackend.frameValues`).
   *
   * @param frame Expression coefficients, the params block, the skin rows.
   * @returns Nothing.
   */
  update(frame: { expr: Float32Array; params: Float32Array; skinRows: Float32Array }): void;
  /** The input and output attributes, for the owner to release. */
  readonly attributes: readonly StorageInstancedBufferAttribute[];
}

/**
 * Build the head pass for a parsed pack.
 *
 * @param pack The parsed `.aosrig` pack.
 * @param webgl True on the WebGL2 fallback: PBO inputs, a padded full dispatch.
 * @returns The node.
 * @example
 * ```ts
 * const gnm = createGnmNode(backend.assets, webgl);
 * gnm.update(backend.frameValues());
 * renderer.compute([gnm.compute, deform.compute]);
 * ```
 */
export function createGnmNode(pack: AosRigPack, webgl: boolean): GnmNode {
  const V = pack.vertexCount;
  const E = pack.coeffCount;
  const M = pack.maxInfluence;
  if (M > 4) throw new Error(`gnm: ${String(M)} influences per vertex; the TSL head pass takes 4`);
  const J = pack.header.joints.length;
  const capacity = webgl ? padTextureShape(V) : V;

  // Per-vertex inputs, packed.
  const neutralEye = new Float32Array(V * 4);
  const stitchEye = new Float32Array(V * 4);
  const skinW = new Float32Array(V * 4);
  const skinI = new Uint32Array(V * 4);
  for (let v = 0; v < V; v++) {
    for (let k = 0; k < 3; k++) {
      neutralEye[v * 4 + k] = pack.neutral[v * 3 + k] ?? 0;
      stitchEye[v * 4 + k] = pack.stitchLocal ? (pack.stitchLocal[v * 3 + k] ?? 0) : 0;
    }
    neutralEye[v * 4 + 3] = pack.eyeWeights[v] ?? 0;
    stitchEye[v * 4 + 3] = pack.eyeWeights[V + v] ?? 0;
    for (let k = 0; k < M; k++) {
      skinW[v * 4 + k] = pack.skinWeight[v * M + k] ?? 0;
      skinI[v * 4 + k] = pack.skinIndex[v * M + k] ?? 0;
    }
  }
  // One spare word: a coefficient's second read may reach one past the last pair.
  const basisWords = new Uint32Array(pack.basis.length + 1);
  basisWords.set(pack.basis);

  const attributes: StorageInstancedBufferAttribute[] = [];
  const input = <T extends 'vec4' | 'uvec4' | 'uint'>(
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
  const neutralNode = input(neutralEye, 4, 'vec4');
  const stitchNode = input(stitchEye, 4, 'vec4');
  const weightNode = input(skinW, 4, 'vec4');
  const jointNode = input(skinI, 4, 'uvec4');
  const basisNode = input(basisWords, 1, 'uint');

  const outputAttribute = new StorageInstancedBufferAttribute(new Float32Array(capacity * 4), 4);
  attributes.push(outputAttribute);
  const output = storage(outputAttribute, 'vec4', capacity);

  // Per-frame values.
  const groups = Math.ceil(E / 4);
  const coeffValues = Array.from({ length: groups }, () => new Vector4());
  const coeffs = uniformArray<'vec4'>(coeffValues, 'vec4');
  const rowValues = Array.from({ length: J * 3 }, () => new Vector4());
  const rows = uniformArray<'vec4'>(rowValues, 'vec4');
  const eye0 = new Vector4(),
    eye1 = new Vector4(),
    rot0 = new Vector4(1, 0, 0, 0),
    rot1 = new Vector4(1, 0, 0, 0);
  const eyePos0 = uniform(eye0),
    eyePos1 = uniform(eye1),
    eyeRot0 = uniform(rot0),
    eyeRot1 = uniform(rot1);
  const useStitch = pack.stitchLocal !== undefined;

  const blend = Fn(() => {
    primeTextureReads(webgl, basisNode);
    const v = instanceIndex;
    const live = v.lessThan(uint(V));
    const at = select(live, v, uint(0)).toVar('vertex');
    const ne = vec4(neutralNode.element(at)).toVar('neutralEye');
    const p = ne.xyz.toVar('p');

    // 1) neutral + sum_c coeff[c] * basis[v][c], four coefficients per uniform vec4
    const row = at.mul(uint(E * 3)).toVar('basisRow');
    Loop(groups, ({ i }: { i: Node<'int'> }) => {
      const g = uint(i).toVar('group');
      const cv = coeffs.element(g).toVar('coeffs');
      for (const [lane, key] of (['x', 'y', 'z', 'w'] as const).entries()) {
        const w = cv[key];
        If(w.notEqual(0), () => {
          const slot = row
            .add(g.mul(uint(12)))
            .add(uint(lane * 3))
            .toVar(`slot${String(lane)}`);
          const word = slot.shiftRight(uint(1)).toVar(`word${String(lane)}`);
          const first = vec2(
            unpackHalf2x16(basisNode.element(word)) as unknown as Node<'vec2'>,
          ).toVar(`pairA${String(lane)}`);
          const second = vec2(
            unpackHalf2x16(basisNode.element(word.add(uint(1)))) as unknown as Node<'vec2'>,
          ).toVar(`pairB${String(lane)}`);
          const odd = slot.bitAnd(uint(1)).equal(uint(1));
          const d = select(
            odd,
            vec3(first.y, second.x, second.y),
            vec3(first.x, first.y, second.x),
          );
          p.addAssign(d.mul(w));
        });
      }
    });

    // 2) gaze: each eye turns about its joint, blended by its skinning weight
    const turn = (q: Node<'vec4'>, x: Node<'vec3'>): Node<'vec3'> => {
      const u = vec3(q.y, q.z, q.w);
      const c = cross(u, x).mul(2);
      return x.add(c.mul(q.x)).add(cross(u, c));
    };
    const se = vec4(stitchNode.element(at)).toVar('stitchEye');
    If(ne.w.notEqual(0), () => {
      const rel = p.sub(eyePos0.xyz).toVar('relL');
      p.addAssign(turn(eyeRot0, rel).sub(rel).mul(ne.w));
    });
    If(se.w.notEqual(0), () => {
      const rel = p.sub(eyePos1.xyz).toVar('relR');
      p.addAssign(turn(eyeRot1, rel).sub(rel).mul(se.w));
    });

    // 3) the neck seam
    if (useStitch) p.addAssign(se.xyz);

    // 4) linear-blend skinning over three row-major vec4 per joint; zero weights skipped
    const p4 = vec4(p, 1).toVar('p4');
    const acc = vec3(0).toVar('acc');
    const weights = vec4(weightNode.element(at)).toVar('skinWeights');
    const joints = jointNode.element(at).toVar('skinJoints');
    for (const key of ['x', 'y', 'z', 'w'] as const) {
      const w = weights[key];
      If(w.notEqual(0), () => {
        const r = joints[key].mul(uint(3)).toVar(`skinRow${key}`);
        acc.addAssign(
          vec3(
            dot(rows.element(r), p4),
            dot(rows.element(r.add(uint(1))), p4),
            dot(rows.element(r.add(uint(2))), p4),
          ).mul(w),
        );
      });
    }

    const result = vec4(acc, 1);
    if (webgl) output.element(v).assign(select(live, result, vec4(0)));
    else
      If(live, () => {
        output.element(v).assign(result);
      });
  });

  const compute = blend().compute(capacity, [64]);

  return {
    compute,
    outputAttribute,
    capacity,
    update(frame) {
      for (let g = 0; g < groups; g++) {
        const c = g * 4;
        const s = pack.basisScale;
        coeffValues[g].set(
          (frame.expr[c] ?? 0) * (s[c] ?? 0),
          (frame.expr[c + 1] ?? 0) * (s[c + 1] ?? 0),
          (frame.expr[c + 2] ?? 0) * (s[c + 2] ?? 0),
          (frame.expr[c + 3] ?? 0) * (s[c + 3] ?? 0),
        );
      }
      for (let r = 0; r < J * 3; r++) rowValues[r].fromArray(frame.skinRows, r * 4);
      const f = frame.params;
      eye0.set(f[4], f[5], f[6], 0);
      eye1.set(f[8], f[9], f[10], 0);
      rot0.fromArray(f, 12);
      rot1.fromArray(f, 16);
    },
    attributes,
  };
}
