/**
 * The deformation of `createAosrigSplat`: the head pass (`gnmNode.ts`) and the splat
 * deformation (`boundSplatNode.ts`), both TSL compute nodes, dispatched together once a frame
 * with `renderer.compute([head, deform])`. The same nodes run on WebGPU and on the WebGL2
 * fallback, where three turns them into two transform-feedback passes and the second reads the
 * first's output through its PBO texture.
 */
import { storage } from 'three/tsl';
import type { ComputeNode } from 'three/webgpu';

import type { GnmNode } from '../rig/gnm/gnmNode.js';
import type { SplatSink } from '../splatSink.js';
import { createBoundSplatNode, type BoundInputs, type BoundSplatNode } from './boundSplatNode.js';

/** The assembled nodes plus what the runtime drives each frame. */
export interface TslDeform {
  readonly node: BoundSplatNode;
  readonly head: GnmNode;
  /**
   * Dispatch the head pass, then the deformation.
   *
   * @returns Nothing.
   */
  dispatch(): void;
  /**
   * Free the inputs and outputs of both nodes.
   *
   * @returns Nothing.
   */
  dispose(): void;
}

/**
 * Assemble a character's inputs into the TSL deformation, reading the head pass's output.
 *
 * @param o The inputs, the character's first slot, the head pass, the sink.
 * @param o.inputs The gaussians (`createBoundInputs`, every chunk added).
 * @param o.offset The character's first slot in the sink.
 * @param o.joints The skeleton's joint count.
 * @param o.bandAt Where the lips' band shapes start in `inputs.extra`.
 * @param o.head The head pass whose output the deformation reads.
 * @param o.sink The sink the gaussians are written to.
 * @param o.renderer The renderer that owns the sink; runs the nodes.
 * @param o.webgl The renderer is on the WebGL2 fallback.
 * @param o.releaseBuffer Frees a storage attribute's GPU buffers on dispose.
 * @returns The deformation.
 * @example
 * ```ts
 * const head = createGnmNode(backend.assets, webgl);
 * const deform = createTslDeform({ inputs, offset: range.offset, joints, bandAt, head, sink,
 *   renderer, webgl });
 * head.update(backend.frameValues());
 * deform.dispatch();
 * ```
 */
export function createTslDeform(o: {
  readonly inputs: BoundInputs;
  readonly offset: number;
  readonly joints: number;
  readonly bandAt: number;
  readonly head: GnmNode;
  readonly sink: SplatSink;
  readonly renderer: { compute(node: ComputeNode | ComputeNode[]): unknown };
  readonly webgl: boolean;
  readonly releaseBuffer?: (attribute: object) => void;
}): TslDeform {
  const { sink, webgl } = o;
  if (!sink.nodes || sink.storageCapacity === undefined)
    throw new Error('aosrig-splat: the deformation needs a sink with storage nodes');
  // The head pass's output, read-only here; on WebGL through its PBO texture.
  const head = storage(o.head.outputAttribute, 'vec4', o.head.capacity).toReadOnly();
  if (webgl) head.setPBO(true);

  const node = createBoundSplatNode({
    inputs: o.inputs,
    offset: o.offset,
    joints: o.joints,
    bandAt: o.bandAt,
    head,
    outputs: sink.nodes,
    storageCapacity: sink.storageCapacity,
    webgl,
  });
  const passes = [o.head.compute, node.compute];

  return {
    node,
    head: o.head,
    dispatch() {
      o.renderer.compute(passes);
    },
    dispose() {
      for (const attribute of [...node.attributes, ...o.head.attributes]) {
        o.releaseBuffer?.(attribute);
        attribute.dispose();
      }
    },
  };
}
