// The one value type that flows between decoder stages.
//
// Ported from aos-threejs-poc/src/ogs/graph/types.ts @ cdd63b10 — the NodeTensor
// half only. The node-graph contract (ports, edges, dirty sources, `evaluate`) is
// DROPPED: it existed so a blueprint editor could rewire the pipeline at runtime, and
// a game engine has no such editor. What is left is a decoder chain with a fixed
// shape, which is what every bundle ever ran anyway.

import type * as ort from '../ort.js';
import type { LiftInput } from '../types.js';

/** A CPU `Float32Array`, or a live gpu-buffer ORT tensor on the shared device. */
export type NodeTensor =
  | { readonly loc: 'cpu'; readonly data: Float32Array; readonly dims: readonly number[] }
  | { readonly loc: 'gpu-buffer'; readonly tensor: ort.Tensor; readonly dims: readonly number[] };

/**
 * True when the tensor's data lives on the GPU.
 *
 * @param v The tensor to classify.
 * @returns True for a live gpu-buffer ORT tensor, false for a CPU `Float32Array`.
 */
export const isGpuTensor = (v: NodeTensor): boolean => v.loc === 'gpu-buffer';

/**
 * Adapt a `NodeTensor` to the lifter's `LiftInput` union.
 *
 * @param v The decoder output to hand on to the lift.
 * @returns The `Float32Array` itself for a CPU tensor; for a gpu-buffer one, the
 * tensor's `GPUBuffer` plus the byte length implied by `dims` at four bytes a float.
 */
export function nodeTensorToLiftInput(v: NodeTensor): LiftInput {
  if (v.loc === 'cpu') return v.data;
  const n = v.dims.reduce((a, b) => a * b, 1);
  return {
    gpuBuffer: (v.tensor as unknown as { gpuBuffer: GPUBuffer }).gpuBuffer,
    byteLength: n * 4,
  };
}

/**
 * Wrap a `LiftInput` as a `NodeTensor` (dims must match its byte length).
 *
 * @param v The lift input to wrap: a CPU `Float32Array`, or a `GPUBuffer` handle.
 * @param dims The shape to record against it; nothing here checks it.
 * @returns A CPU `NodeTensor` for a `Float32Array`; otherwise a gpu-buffer one whose
 * `tensor` is a stand-in carrying the `gpuBuffer` alone, not a real ORT tensor.
 */
export function liftInputToNodeTensor(v: LiftInput, dims: readonly number[]): NodeTensor {
  if (v instanceof Float32Array) return { loc: 'cpu', data: v, dims };
  return {
    loc: 'gpu-buffer',
    tensor: { gpuBuffer: v.gpuBuffer } as unknown as ort.Tensor,
    dims,
  };
}
