// GPU-resident ORL deform: blendshapes + LBS in WGSL, on the SAME device the lift
// owns, writing into a GPUBuffer the lift consumes via `setPoseGpu`.
//
// Per frame the CPU does only the cheap, low-volume half — the wasm rig eval and
// the 870-joint hierarchy walk — and uploads two small uniforms:
//
//   skin rows   J*12 floats   ~42 KB   (870 joints)
//   bs weights  ~782 floats   ~3 KB
//
// instead of the 288 KB of posed vertices the CPU path pushed every frame. The
// vertices themselves are born on the GPU and never touch the CPU again.
//
// NO FENCES ARE NEEDED. One device means one queue, and WebGPU executes
// submissions in order: this pass is recorded before the lift's copy, so the copy
// provably reads finished output; next frame's overwrite is ordered after the
// previous copy. Nothing here maps a buffer or waits.
//
// Ported from aos-threejs-poc/src/lib/orl/OrlGpuDeform.js @ cdd63b10, with two
// changes: `deform` RECORDS into a caller-supplied encoder instead of submitting its
// own, so a whole character's geometry half is ONE submission across every branch;
// and both uniforms are uploaded only when their bytes changed, so a still character
// costs no `writeBuffer` at all.

import { orlDeformWgsl } from '../../generated/index.js';
import type { BlendshapeCsr } from './csr.js';
import type { OrlDeformer } from './deform.js';
import { uniformCapacityError } from './gpuLimits.js';

/** The GPU half of the ORL deform. */
export interface OrlGpuDeform {
  /** Record one frame's pass. Returns the output buffer; does not submit. */
  deform(
    encoder: GPUCommandEncoder,
    jointOut: Float32Array,
    bsOut: Float32Array,
  ): { gpuBuffer: GPUBuffer; byteLength: number };
  /** DEBUG ONLY — maps the output back to the CPU. Drains the queue. */
  readback(): Promise<Float32Array>;
  /** Approximate GPU bytes held. */
  bytes(): number;
  destroy(): void;
  readonly buffer: GPUBuffer;
  readonly byteLength: number;
}

/**
 * Build the WGSL ORL deform.
 *
 * @param device MUST be the device the lift was built on — a `copyBufferToBuffer`
 *   across devices is invalid.
 * @param deformer From `createDeformer()`: supplies V/J/maxInf, the static buffers
 *   and `computeSkinRows()`.
 * @param csr From `buildBlendshapeCsr()`.
 * @param numChannels `manifest.numBlendShapeChannels`.
 * @returns The GPU deform. Its static buffers (neutral, CSR, skin weights) are
 *   uploaded here, once; per frame only the skin rows and the padded blendshape
 *   weights are written.
 */
export function createOrlGpuDeform(
  device: GPUDevice,
  deformer: OrlDeformer,
  csr: BlendshapeCsr,
  numChannels: number,
): OrlGpuDeform {
  const { V, J, maxInf } = deformer;
  const bsVec4 = Math.ceil(numChannels / 4);

  // Refused here rather than by the pipeline: the caller catches this and keeps the
  // CPU deform (same vertices, slower), so what is actually at stake is whether the
  // log line names the DNA or names a binding index. See gpuLimits.ts.
  const capacity = uniformCapacityError(J, device);
  if (capacity) throw new Error(`[orl] ${capacity}`);

  const code = orlDeformWgsl
    .replace(/SKIN_ROWS/g, String(J * 3))
    .replace(/BS_VEC4/g, String(bsVec4));
  const pipeline = device.createComputePipeline({
    layout: 'auto',
    compute: {
      module: device.createShaderModule({ code, label: 'orl_deform' }),
      entryPoint: 'main',
    },
  });

  const storage = (data: Float32Array | Uint32Array, label: string): GPUBuffer => {
    const buf = device.createBuffer({
      label,
      size: data.byteLength,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(buf, 0, data.buffer, data.byteOffset, data.byteLength);
    return buf;
  };

  // skin_idx ships as uint16; WGSL storage has no u16.
  const skinIdx32 = Uint32Array.from(deformer.buffers.skinIdx);

  const bufNeutral = storage(deformer.neutral, 'orl_neutral');
  const bufCsrOffset = storage(csr.offset, 'orl_csr_offset');
  const bufCsrChannel = storage(csr.channel, 'orl_csr_channel');
  const bufCsrDelta = storage(csr.delta, 'orl_csr_delta');
  const bufSkinIdx = storage(skinIdx32, 'orl_skin_idx');
  const bufSkinW = storage(deformer.buffers.skinW, 'orl_skin_w');
  const bufOut = device.createBuffer({
    label: 'orl_out_verts',
    size: V * 3 * 4,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
  });

  const bufSkinRows = device.createBuffer({
    label: 'orl_skin_rows',
    size: J * 12 * 4,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
  const bufBsWeights = device.createBuffer({
    label: 'orl_bs_weights',
    size: bsVec4 * 16,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
  const bufParams = device.createBuffer({
    label: 'orl_params',
    size: 16,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
  device.queue.writeBuffer(bufParams, 0, new Uint32Array([V, maxInf, 0, 0]));

  const bindGroup = device.createBindGroup({
    layout: pipeline.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: { buffer: bufNeutral } },
      { binding: 1, resource: { buffer: bufCsrOffset } },
      { binding: 2, resource: { buffer: bufCsrChannel } },
      { binding: 3, resource: { buffer: bufCsrDelta } },
      { binding: 4, resource: { buffer: bufSkinIdx } },
      { binding: 5, resource: { buffer: bufSkinW } },
      { binding: 6, resource: { buffer: bufOut } },
      { binding: 7, resource: { buffer: bufSkinRows } },
      { binding: 8, resource: { buffer: bufBsWeights } },
      { binding: 9, resource: { buffer: bufParams } },
    ],
  });

  // Reused per frame — the bs weights padded out to whole vec4s.
  const bsPadded = new Float32Array(bsVec4 * 4);
  // Which of the two uniforms have ever been uploaded. After that the writes are
  // gated on the bytes actually changing: an idle character re-sent 42 KB of skin
  // rows and 3 KB of blendshape weights every frame for no change at all.
  let uploadedRows = -1;
  let uploadedWeights = false;
  const byteLength = V * 3 * 4;
  const owned = [
    bufNeutral,
    bufCsrOffset,
    bufCsrChannel,
    bufCsrDelta,
    bufSkinIdx,
    bufSkinW,
    bufOut,
    bufSkinRows,
    bufBsWeights,
    bufParams,
  ];
  let destroyed = false;

  /**
   * Record one frame's deform pass; the caller submits.
   *
   * @param encoder The frame's encoder. The pass is recorded before the lift's copy,
   *   which is what makes the copy provably read finished output.
   * @param jointOut ORL's `getJointOutputs()`, 9 floats per joint. Turned into the
   *   packed skin rows on the CPU and uploaded as a uniform.
   * @param bsOut ORL's `getBlendShapeOutputs()`. Padded out to whole vec4s.
   * @returns The output vertex buffer and its byte length: V xyz triples, fp32, in
   *   CENTIMETRES. The same buffer every frame.
   */
  function deform(
    encoder: GPUCommandEncoder,
    jointOut: Float32Array,
    bsOut: Float32Array,
  ): { gpuBuffer: GPUBuffer; byteLength: number } {
    if (destroyed) throw new Error('[orl] gpu deform used after destroy()');
    const rows = deformer.computeSkinRows(jointOut);
    // `skinGeneration` only advances when the solve moved, so this compares one
    // integer instead of 10,440 floats.
    if (uploadedRows !== deformer.skinGeneration) {
      uploadedRows = deformer.skinGeneration;
      device.queue.writeBuffer(bufSkinRows, 0, rows.buffer, rows.byteOffset, rows.byteLength);
    }
    let weightsMoved = !uploadedWeights;
    const shared = Math.min(bsOut.length, bsPadded.length);
    for (let i = 0; i < bsPadded.length; i++) {
      const previous = bsPadded[i];
      bsPadded[i] = i < shared ? bsOut[i] : 0;
      if (bsPadded[i] !== previous) weightsMoved = true;
    }
    if (weightsMoved) {
      uploadedWeights = true;
      device.queue.writeBuffer(
        bufBsWeights,
        0,
        bsPadded.buffer,
        bsPadded.byteOffset,
        bsPadded.byteLength,
      );
    }

    const pass = encoder.beginComputePass({ label: 'orl_deform' });
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.dispatchWorkgroups(Math.ceil(V / 64));
    pass.end();
    return { gpuBuffer: bufOut, byteLength };
  }

  /**
   * DEBUG ONLY: copy the posed vertices back to the CPU.
   *
   * Submits its own encoder and maps the staging buffer, so it drains the queue —
   * the GPU-vs-CPU gate uses it, the frame loop must not.
   *
   * @returns A copy of the output buffer: V xyz triples in centimetres.
   */
  async function readback(): Promise<Float32Array> {
    const staging = device.createBuffer({
      label: 'orl_readback',
      size: byteLength,
      usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
    });
    const encoder = device.createCommandEncoder({ label: 'orl_readback' });
    encoder.copyBufferToBuffer(bufOut, 0, staging, 0, byteLength);
    device.queue.submit([encoder.finish()]);
    await staging.mapAsync(GPUMapMode.READ);
    const copy = new Float32Array(staging.getMappedRange().slice(0));
    staging.unmap();
    staging.destroy();
    return copy;
  }

  return {
    deform,
    readback,
    bytes: () => owned.reduce((total, b) => total + b.size, 0),
    destroy() {
      destroyed = true;
      for (const b of owned) b.destroy();
    },
    buffer: bufOut,
    byteLength,
  };
}
