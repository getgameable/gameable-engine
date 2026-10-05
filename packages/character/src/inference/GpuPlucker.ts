// GPU plücker-ray generator. Computes the `[1,6,1,H,W]` tensor the appearance
// decoder consumes directly into a GPU buffer on ORT's device, so it is fed to
// `appr.run()` as a gpu-buffer input with no CPU->GPU upload — replacing the CPU
// loop (65k texels) plus the per-run upload of a 6·H·W f32 array.
//
// MUST be constructed with ORT's own `GPUDevice` (`ort.env.webgpu.device`, which
// is the renderer's device once `attachOrtDevice` has run) so the produced buffer
// is valid as an appr input — a buffer from a different device throws "Buffer is
// associated with [Device], cannot be used with [Device]". Off that path, fall
// back to the CPU `computePluckerRays`.
//
// Ported from aos-threejs-poc/src/ogs/inference/GpuPlucker.ts @ cdd63b10

import { Quaternion, Vector3 } from 'three/webgpu';

import { pluckerWgsl } from '../generated/index.js';
import * as ort from '../ort.js';
import {
  ORIGIN_ZERO,
  toLocalOrigin,
  toLocalRotation,
  type PluckerCamera,
  type PluckerFrame,
} from './plucker.js';

/** The ray buffer, its uniform, the bind group and the ORT tensor over it. */
interface PluckerRays {
  buffer: GPUBuffer;
  uniform: GPUBuffer;
  bindGroup: GPUBindGroup;
  tensor: ort.Tensor;
}

/** One reused plücker buffer + its ORT tensor wrapper. */
export class GpuPlucker {
  private readonly device: GPUDevice;
  private readonly pipeline: GPUComputePipeline;
  // ONE nullable field rather than four: the buffer, its uniform, the bind group and
  // the ORT tensor are created and destroyed together, so a caller that has one has
  // all of them.
  private rays: PluckerRays | null = null;
  private W = 0;
  private H = 0;
  private stride = 0;
  private destroyed = false;

  // Scratch, reused to avoid per-frame allocation on the inference path.
  private readonly _o = new Vector3();
  private readonly _q = new Quaternion();
  private readonly _f = new Vector3();
  private readonly _r = new Vector3();
  private readonly _u = new Vector3();
  private readonly _stage = new ArrayBuffer(96);
  private readonly _f32 = new Float32Array(this._stage);
  private readonly _u32 = new Uint32Array(this._stage);

  constructor(device: GPUDevice) {
    this.device = device;
    this.pipeline = device.createComputePipeline({
      label: 'character_plucker',
      layout: 'auto',
      compute: {
        module: device.createShaderModule({ code: pluckerWgsl, label: 'character_plucker' }),
        entryPoint: 'main',
      },
    });
  }

  private ensure(W: number, H: number): PluckerRays {
    const existing = this.rays;
    if (existing && this.W === W && this.H === H) return existing;
    existing?.buffer.destroy();
    existing?.uniform.destroy();
    this.W = W;
    this.H = H;
    this.stride = W * H;
    const buffer = this.device.createBuffer({
      label: 'plucker',
      size: 6 * this.stride * 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
    });
    const uniform = this.device.createBuffer({
      label: 'plucker_params',
      size: 96,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    const bindGroup = this.device.createBindGroup({
      layout: this.pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer } },
        { binding: 1, resource: { buffer: uniform } },
      ],
    });
    const tensor = ort.Tensor.fromGpuBuffer(buffer, {
      dataType: 'float32',
      dims: [1, 6, 1, H, W],
    });
    this.rays = { buffer, uniform, bindGroup, tensor };
    return this.rays;
  }

  /**
   * Record the plücker rays for `camera` into `encoder` and return the (reused) ORT
   * gpu-buffer tensor.
   *
   * NOTHING IS SUBMITTED HERE. The dispatch joins the frame's one encoder alongside
   * every branch's rig deform and vertex transform, and the caller submits that
   * encoder BEFORE awaiting `appr.run()` — which is what makes the buffer ORT reads
   * finished rather than in flight. One device means one queue, so a submission that
   * has been made is ordered ahead of whatever ORT enqueues next.
   *
   * The camera is taken into the splat's local frame HERE rather than in the
   * shader — the pose is already a CPU value, and doing it here keeps
   * `plucker.wgsl` byte-identical to its CPU reference so the two cannot drift.
   * The shader still applies `originScale` (see `wgsl/plucker.wgsl`).
   *
   * @param camera The viewing camera; its world position and quaternion are copied into the
   *   reused scratch, never mutated.
   * @param W Ray-grid width in texels; a change from the last call reallocates the buffer.
   * @param H Ray-grid height in texels, likewise.
   * @param frame How this branch's trained frame relates to world; `originScale` and
   *   `momentScale` go to the shader as uniforms, the offset and rotation are applied here.
   * @param encoder The frame's command encoder, recorded into but never submitted here.
   * @returns The reused `[1, 6, 1, H, W]` float32 gpu-buffer tensor, ready as an appr
   *   input once `encoder` has been submitted.
   */
  compute(
    camera: PluckerCamera,
    W: number,
    H: number,
    frame: PluckerFrame,
    encoder: GPUCommandEncoder,
  ): ort.Tensor {
    const rays = this.ensure(W, H);
    camera.getFramePosition(this._o);
    toLocalOrigin(this._o, frame.worldOffset ?? ORIGIN_ZERO);
    this._q.copy(camera.quaternion);
    toLocalRotation(this._o, this._q, frame.worldRotation ?? null);
    const fovRad = (camera.fov * Math.PI) / 180;
    const tanFov = Math.tan(fovRad / 2);
    this._f.set(0, 0, -1).applyQuaternion(this._q);
    this._r.set(1, 0, 0).applyQuaternion(this._q);
    this._u.set(0, 1, 0).applyQuaternion(this._q);

    const f = this._f32;
    const u = this._u32;
    f[0] = this._o.x;
    f[1] = this._o.y;
    f[2] = this._o.z;
    f[4] = this._f.x;
    f[5] = this._f.y;
    f[6] = this._f.z;
    f[8] = this._r.x;
    f[9] = this._r.y;
    f[10] = this._r.z;
    f[12] = this._u.x;
    f[13] = this._u.y;
    f[14] = this._u.z;
    f[16] = tanFov;
    f[17] = camera.aspect;
    f[18] = frame.originScale ?? 1;
    f[19] = frame.momentScale ?? 0;
    u[20] = W;
    u[21] = H;
    u[22] = this.stride;

    this.device.queue.writeBuffer(rays.uniform, 0, this._stage);
    const pass = encoder.beginComputePass({ label: 'plucker' });
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, rays.bindGroup);
    pass.dispatchWorkgroups(Math.ceil(this.stride / 64));
    pass.end();
    return rays.tensor;
  }

  /**
   * Read the most recently computed plücker buffer back to CPU so a parity check
   * can diff it against `computePluckerRays`. Not on the hot path.
   *
   * @returns The `6 * W * H` floats in the same channel-major layout as
   *   `computePluckerRays`, or `null` when nothing has been computed yet or this has been
   *   destroyed.
   */
  async debugReadback(): Promise<Float32Array | null> {
    const rays = this.rays;
    if (this.destroyed || !rays) return null;
    const size = 6 * this.stride * 4;
    const rb = this.device.createBuffer({
      size,
      usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
    });
    const enc = this.device.createCommandEncoder({ label: 'plucker_readback' });
    enc.copyBufferToBuffer(rays.buffer, 0, rb, 0, size);
    this.device.queue.submit([enc.finish()]);
    await rb.mapAsync(GPUMapMode.READ);
    const out = new Float32Array(rb.getMappedRange().slice(0));
    rb.unmap();
    rb.destroy();
    return out;
  }

  /** Release the ray buffer and its uniform. */
  destroy(): void {
    this.destroyed = true;
    this.rays?.buffer.destroy();
    this.rays?.uniform.destroy();
    this.rays = null;
  }
}
