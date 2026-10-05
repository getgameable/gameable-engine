// The UV -> 3D gaussian lift, in WGSL, writing STRAIGHT INTO the splat sink.
//
// Rewritten from aos-threejs-poc/src/ogs/inference/GpuLifter.ts @ cdd63b10.
//
// The POC ran the same two compute passes and then read the result back to the
// CPU, because its renderer was Spark on WebGL and WebGPU->WebGL has no zero-copy
// path. Here the renderer IS WebGPU and owns the device, so the readback, the
// staging buffer, the SoA deserialize loop and the Spark `PackedSplats`
// quantisation all disappear: pass 2 writes `center` / `covarianceA` /
// `covarianceB` / `color` at `slotOffset + texel` and the frame is done. There is
// no CPU lift at all — a second implementation of this maths could only disagree
// with the shader, silently.
//
// WHAT IS UNCHANGED, deliberately: every clamp. `scaleLogBias`, `scaleLogMax`,
// `sigmaMax`/`sigmaOffset`, `triKappa` and `sliverQMin` are the bundle's own
// numbers, applied in pass 1 exactly as the POC applies them, because the trainer
// applies them AFTER the decoder — they are not in the ONNX graph, and a lift that
// drops one renders a different model with nothing to see.
//
// PASS 1 BINDS 8 STORAGE BUFFERS, which is WebGPU's DEFAULT limit, so no adapter
// is refused the lift over a limit. It asked for 9 until `valid` was folded into
// `triim` (`liftTriim.ts`); the integrated GPUs that report exactly 8 were then
// silently falling back to a seconds-per-frame CPU path.

import {
  jacobianWgsl,
  liftPass1Wgsl,
  liftPass2CovWgsl,
  vertTransformWgsl,
} from '../generated/index.js';
import type { MeshAssets } from '../assets/loader.js';
import type { SlotRange, SplatSinkBuffers } from '../splatSink.js';
import type { LiftInput, OpacityMask } from '../types.js';
import { validityMaskedTriim } from './liftTriim.js';
import { scaleMapConstants, type ScaleMapConstants } from './splatScale.js';
import { packVertTransformParams, VERT_TRANSFORM_PARAMS_BYTES } from './vertTransformParams.js';

/** The bundle's out-of-ONNX lift parameters, straight off the branch spec. */
export interface LiftParams {
  scaleLogBias?: number;
  scaleLogMax?: number;
  triKappa?: number;
  sliverQMin?: number;
  uvErode?: number;
  sigmaMax?: number;
  sigmaOffset?: number;
}

/** Where this branch's gaussians land in the scene. */
export interface LiftPlacement {
  /** Bundle verts -> scene metres (a cm bundle is 0.01). Folded into the lift. */
  worldScale: number;
  /** Scene placement, metres. */
  worldOffset: readonly [number, number, number];
  /**
   * The training frame's orientation as a quaternion `(w, x, y, z)`, undone here.
   * `[1, 0, 0, 0]` for a bundle that declares none — see `../render/worldRotation.ts`.
   */
  worldRotation: readonly [number, number, number, number];
}

/**
 * `Float32Array.buffer` is `ArrayBufferLike`; `@webgpu/types` wants `ArrayBuffer`.
 *
 * @param device The device whose queue the write is enqueued on.
 * @param buf The destination GPU buffer.
 * @param offset Byte offset into `buf` to write at.
 * @param data The typed-array view to upload; only its own byte range is sent, so a
 *   subarray of a larger backing buffer uploads just its own span.
 */
function writeView(device: GPUDevice, buf: GPUBuffer, offset: number, data: ArrayBufferView): void {
  device.queue.writeBuffer(buf, offset, data.buffer, data.byteOffset, data.byteLength);
}

/** The lazily-built rig -> checkpoint transform pass and everything it binds. */
interface TransformPass {
  readonly pipeline: GPUComputePipeline;
  readonly params: GPUBuffer;
  /** Reassigned when a real correction replaces the dummy. */
  corr: GPUBuffer;
  bindGroup: GPUBindGroup;
}

/**
 * `uv_erode` values already reported. Once per process, not once per branch: a
 * character with five branches printed the same warning five times a load, and the
 * showcase reloads a character every time you switch identity.
 */
const warnedUvErode = /* @__PURE__ */ new Set<number>();

/** Two WGSL compute passes: UV decoder outputs in, splat-sink slots out. */
export class GpuLifter {
  private readonly device: GPUDevice;
  private readonly numFaces: number;
  private readonly numVerts: number;
  private readonly uvRes: number;
  private readonly hw: number;
  private readonly range: SlotRange;

  private readonly jacobianPipeline: GPUComputePipeline;
  private readonly pass1Pipeline: GPUComputePipeline;
  private readonly pass2Pipeline: GPUComputePipeline;

  private readonly bufFaces: GPUBuffer;
  private readonly bufIdxim: GPUBuffer;
  private readonly bufBarim: GPUBuffer;
  private readonly bufTriim: GPUBuffer;
  private readonly bufValid: GPUBuffer;
  private readonly bufVerts: GPUBuffer;
  private readonly bufJacobians: GPUBuffer;
  private readonly bufFaceValid: GPUBuffer;
  private readonly bufGeomUv: GPUBuffer;
  private readonly bufColorUv: GPUBuffer;
  private readonly bufPass1Out: GPUBuffer;
  private readonly bufJacobianDims: GPUBuffer;
  private readonly bufLiftDims: GPUBuffer;
  private readonly bufPlacement: GPUBuffer;
  private readonly bufMaskParams: GPUBuffer;
  private bufMaskData: GPUBuffer;
  private maskThreshold = 0.5;

  private readonly jacobianBindGroup: GPUBindGroup;
  private readonly pass1BindGroup: GPUBindGroup;
  private pass2BindGroup!: GPUBindGroup;
  private readonly sinkBindGroup: GPUBindGroup;

  // The rig->checkpoint transform pass, built lazily: only a gpu-resident rig backend
  // (`setPoseGpu`) needs it. ONE nullable field rather than four, so a caller that has
  // checked it once has checked all of it — four independently-nullable buffers turn
  // every use into an assertion that the reader has to re-derive.
  private transform: TransformPass | null = null;
  private bufVertCorrOwned = false;
  private useVertCorr = false;
  /** ROW-major 3x3, applied as the row-vector product `v·M`. Identity until calibrate. */
  private deformLin: number[] = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  private deformOffset: [number, number, number] = [0, 0, 0];

  private destroyed = false;
  private readonly scaleMap: ScaleMapConstants;

  constructor(
    device: GPUDevice,
    mesh: MeshAssets,
    sink: SplatSinkBuffers,
    range: SlotRange,
    placement: LiftPlacement,
    params: LiftParams = {},
  ) {
    this.device = device;
    this.range = range;
    this.uvRes = mesh.manifest.uv_res;
    this.hw = this.uvRes * this.uvRes;
    this.numFaces = mesh.manifest.num_faces;
    this.numVerts = mesh.manifest.num_vertices;
    if (range.count < this.hw) {
      throw new Error(
        `GpuLifter: slot range holds ${String(range.count)} splats, the branch's ${String(this.uvRes)}² atlas needs ${String(this.hw)}`,
      );
    }

    const scaleLogBias = params.scaleLogBias ?? 0;
    const scaleLogMax = params.scaleLogMax ?? Infinity;
    const triKappa = params.triKappa ?? 0;
    const sliverQMin = params.sliverQMin ?? 0;
    this.scaleMap = scaleMapConstants({
      sigmaMax: params.sigmaMax ?? 0,
      sigmaOffset: params.sigmaOffset ?? 0,
      scaleLogBias,
      scaleLogMax,
    });
    // `uv_erode` is ACCEPTED AND REPORTED, never silently dropped. Pass 2's keep
    // test would have to use min-pool(valid, uvErode) while pass 1's
    // identity-Jacobian test uses the RAW mask, and the WGSL path folds `valid`
    // into `triim` to stay inside the 8-binding limit — so the split needs that
    // packing changed, not just a uniform. Chart-edge splats differ from training
    // until then, and a bundle that asks for it deserves to hear so.
    const uvErode = (params.uvErode ?? 0) | 0;
    if (uvErode > 0 && !warnedUvErode.has(uvErode)) {
      warnedUvErode.add(uvErode);
      console.warn(
        `[character] GpuLifter: uv_erode=${String(uvErode)} is not applied on the WebGPU path — ` +
          'chart-edge splats will differ from training.',
      );
    }

    const mkPipeline = (code: string, label: string) =>
      device.createComputePipeline({
        label,
        layout: 'auto',
        compute: { module: device.createShaderModule({ code, label }), entryPoint: 'main' },
      });
    this.jacobianPipeline = mkPipeline(jacobianWgsl, 'character_jacobian');
    this.pass1Pipeline = mkPipeline(liftPass1Wgsl, 'character_lift_pass1');
    this.pass2Pipeline = mkPipeline(liftPass2CovWgsl, 'character_lift_pass2_cov');

    // Static mesh data.
    this.bufFaces = this.makeStorage(mesh.faces, 'faces');
    this.bufIdxim = this.makeStorage(mesh.idxim, 'idxim');
    this.bufBarim = this.makeStorage(mesh.barim, 'barim');
    // Validity folded in (invalid -> fid -1) so pass 1 binds 8 storage buffers, not 9.
    this.bufTriim = this.makeStorage(validityMaskedTriim(mesh.triim, mesh.valid), 'triim');
    // valid (u8) -> u32 expansion; WGSL has no u8 storage type. Pass 2 samples it bilinearly.
    const validU32 = new Uint32Array(this.hw);
    for (let i = 0; i < this.hw; i++) validU32[i] = mesh.valid[i];
    this.bufValid = this.makeStorage(validU32, 'valid');

    const S = GPUBufferUsage.STORAGE;
    const DST = GPUBufferUsage.COPY_DST;
    this.bufVerts = device.createBuffer({
      label: 'verts',
      size: this.numVerts * 3 * 4,
      usage: S | DST,
    });
    this.bufJacobians = device.createBuffer({
      label: 'jacobians',
      size: this.numFaces * 9 * 4,
      usage: S,
    });
    this.bufFaceValid = device.createBuffer({
      label: 'face_valid',
      size: this.numFaces * 4,
      usage: S,
    });
    this.bufGeomUv = device.createBuffer({
      label: 'geom_uv',
      size: 11 * this.hw * 4,
      usage: S | DST,
    });
    this.bufColorUv = device.createBuffer({
      label: 'color_uv',
      size: 3 * this.hw * 4,
      usage: S | DST,
    });
    this.bufPass1Out = device.createBuffer({
      label: 'pass1_out',
      size: this.hw * 10 * 4,
      usage: S,
    });

    const U = GPUBufferUsage.UNIFORM;
    this.bufJacobianDims = device.createBuffer({
      label: 'jacobian_dims',
      size: 16,
      usage: U | DST,
    });
    device.queue.writeBuffer(this.bufJacobianDims, 0, new Uint32Array([this.numFaces, 0, 0, 0]));

    // 48 bytes, not 32: pass 1 reads SEVEN f32 off the tail (scale_log_bias,
    // scale_log_max, tri_kappa, sliver_q_min, bounded, log_sigma_max,
    // scale_offset) = 16 + 28 = 44.
    this.bufLiftDims = device.createBuffer({ label: 'lift_dims', size: 48, usage: U | DST });
    const liftDims = new ArrayBuffer(48);
    new Uint32Array(liftDims, 0, 4).set([this.uvRes, this.uvRes, this.hw, this.uvRes]);
    // A WGSL f32 has no Infinity to write, so an absent ceiling becomes a value no
    // log-scale reaches. exp(88) is already f32's max, so this clamps nothing real.
    const NO_CEILING = 1e30;
    new Float32Array(liftDims, 16, 7).set([
      // Read by nothing today — pass 1 takes the bias through `scale_offset`, which
      // is what makes the bounded and additive maps one code path. Written anyway so
      // the uniform describes the branch it belongs to. (The POC wrote `undefined`
      // here, i.e. NaN; harmless because unread, but not worth reproducing.)
      scaleLogBias,
      Number.isFinite(this.scaleMap.scaleLogMax) ? this.scaleMap.scaleLogMax : NO_CEILING,
      triKappa,
      sliverQMin,
      this.scaleMap.bounded,
      this.scaleMap.logSigmaMax,
      this.scaleMap.offset,
    ]);
    device.queue.writeBuffer(this.bufLiftDims, 0, liftDims);

    this.bufPlacement = device.createBuffer({ label: 'lift_placement', size: 64, usage: U | DST });
    this.setPlacement(placement);

    // Opacity mask — disabled 1×1 "keep" dummy until setOpacityMask installs one.
    this.bufMaskParams = device.createBuffer({ label: 'mask_params', size: 16, usage: U | DST });
    this.bufMaskData = device.createBuffer({ label: 'mask_data', size: 4, usage: S | DST });
    device.queue.writeBuffer(this.bufMaskData, 0, new Float32Array([1]));
    this.writeMaskParams(0, 1, 1, this.maskThreshold);

    this.jacobianBindGroup = device.createBindGroup({
      label: 'jacobian',
      layout: this.jacobianPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.bufVerts } },
        { binding: 1, resource: { buffer: this.bufFaces } },
        { binding: 2, resource: { buffer: this.bufJacobians } },
        { binding: 3, resource: { buffer: this.bufFaceValid } },
        { binding: 4, resource: { buffer: this.bufJacobianDims } },
      ],
    });
    this.pass1BindGroup = device.createBindGroup({
      label: 'lift_pass1',
      layout: this.pass1Pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.bufJacobians } },
        { binding: 1, resource: { buffer: this.bufFaceValid } },
        { binding: 2, resource: { buffer: this.bufIdxim } },
        { binding: 3, resource: { buffer: this.bufBarim } },
        { binding: 4, resource: { buffer: this.bufTriim } },
        { binding: 5, resource: { buffer: this.bufVerts } },
        { binding: 6, resource: { buffer: this.bufGeomUv } },
        { binding: 7, resource: { buffer: this.bufPass1Out } },
        { binding: 8, resource: { buffer: this.bufLiftDims } },
      ],
    });
    this.buildPass2BindGroup();
    // Group 1 is the sink, which never changes for the life of the branch.
    this.sinkBindGroup = device.createBindGroup({
      label: 'lift_sink',
      layout: this.pass2Pipeline.getBindGroupLayout(1),
      entries: [
        { binding: 0, resource: { buffer: sink.center } },
        { binding: 1, resource: { buffer: sink.covarianceA } },
        { binding: 2, resource: { buffer: sink.covarianceB } },
        { binding: 3, resource: { buffer: sink.color } },
      ],
    });
  }

  /**
   * Slots this lifter owns.
   *
   * @returns The sink range this branch's gaussians are written into — its offset and count.
   */
  get slots(): SlotRange {
    return this.range;
  }

  /**
   * UV resolution; the branch's splat count is its square.
   *
   * @returns The decoder's `uv_res`, i.e. the side length of the UV grid in texels.
   */
  get resolution(): number {
    return this.uvRes;
  }

  /**
   * Bake the bundle's placement into the lift.
   *
   * The POC put `world_scale` / `world_offset` / `world_rotation` on the branch's
   * own `SplatMesh`. One character is ONE splat object here, so there is no
   * per-branch node to hang a transform on and the lift has to emit scene-space
   * gaussians. The plücker camera inverts the same rotation, exactly as the POC
   * does, so the decoders still see the frame they were trained in.
   *
   * @param placement The bundle's `world_scale`, `world_offset` and `world_rotation`, packed
   *   into the pass-2 uniform so every gaussian is emitted in scene space.
   */
  setPlacement(placement: LiftPlacement): void {
    const buf = new ArrayBuffer(64);
    const u = new Uint32Array(buf);
    const f = new Float32Array(buf);
    u[0] = this.range.offset;
    u[1] = this.range.count;
    const q = placement.worldRotation;
    f[4] = q[0];
    f[5] = q[1];
    f[6] = q[2];
    f[7] = q[3];
    f[8] = placement.worldOffset[0];
    f[9] = placement.worldOffset[1];
    f[10] = placement.worldOffset[2];
    f[12] = placement.worldScale;
    this.device.queue.writeBuffer(this.bufPlacement, 0, buf);
  }

  // (Re)build the pass-2 group-0 bind group. Extracted so setOpacityMask can
  // rebind a resized mask-data buffer without recreating the pipeline.
  private buildPass2BindGroup(): void {
    this.pass2BindGroup = this.device.createBindGroup({
      label: 'lift_pass2',
      layout: this.pass2Pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.bufPass1Out } },
        { binding: 1, resource: { buffer: this.bufColorUv } },
        { binding: 2, resource: { buffer: this.bufValid } },
        { binding: 3, resource: { buffer: this.bufLiftDims } },
        { binding: 4, resource: { buffer: this.bufMaskParams } },
        { binding: 5, resource: { buffer: this.bufMaskData } },
        { binding: 6, resource: { buffer: this.bufPlacement } },
      ],
    });
  }

  // Pack the MaskParams uniform: 3×u32 (enabled, w, h) + 1×f32 (threshold).
  private writeMaskParams(enabled: number, w: number, h: number, threshold: number): void {
    const buf = new ArrayBuffer(16);
    new Uint32Array(buf, 0, 3).set([enabled, w, h]);
    new Float32Array(buf, 12, 1)[0] = threshold;
    this.device.queue.writeBuffer(this.bufMaskParams, 0, buf);
  }

  /**
   * Install (or clear) the UV-space opacity mask used to cull occluded gaussians.
   * Pass null to disable. `threshold` (default 0.5) is the mask value below which
   * a sampled gaussian is dropped. The mask uploads once here, not per frame.
   *
   * @param mask The UV-space mask grid, or `null` to disable culling; a zero-sized grid
   *   disables it too.
   * @param opts Options for the cull.
   * @param opts.threshold Mask value below which a gaussian is dropped. Omitted leaves the
   *   current threshold, which starts at 0.5.
   */
  setOpacityMask(mask: OpacityMask | null, opts: { threshold?: number } = {}): void {
    if (this.destroyed) return;
    if (typeof opts.threshold === 'number') this.maskThreshold = opts.threshold;
    if (!mask || mask.width <= 0 || mask.height <= 0) {
      this.writeMaskParams(0, 1, 1, this.maskThreshold);
      return;
    }
    const n = mask.width * mask.height;
    const need = n * 4;
    if (this.bufMaskData.size < need) {
      this.bufMaskData.destroy();
      this.bufMaskData = this.device.createBuffer({
        label: 'mask_data',
        size: need,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      });
      this.buildPass2BindGroup(); // rebind the resized data buffer
    }
    // mask.data may be a larger backing array; upload exactly n floats.
    const data = mask.data.length === n ? mask.data : mask.data.subarray(0, n);
    writeView(this.device, this.bufMaskData, 0, data);
    this.writeMaskParams(1, mask.width, mask.height, this.maskThreshold);
  }

  private makeStorage(data: ArrayBufferView, label: string): GPUBuffer {
    const buf = this.device.createBuffer({
      label,
      size: data.byteLength,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    writeView(this.device, buf, 0, data);
    return buf;
  }

  /**
   * Upload verts + compute per-face jacobians on the GPU.
   *
   * Submits its own encoder, deliberately: this is the LOAD-TIME path
   * (`CharacterBranch.init`, and calibration), not the per-frame one. Per frame the
   * jacobians are rebuilt inside {@link setPoseGpu}, in the frame's own encoder.
   *
   * @param verts The branch's posed vertices as flat xyz triples, already in checkpoint
   *   space — this is the CPU-verts path, so no transform pass runs.
   */
  computeJacobians(verts: Float32Array): void {
    if (this.destroyed) return;
    writeView(this.device, this.bufVerts, 0, verts);
    const encoder = this.device.createCommandEncoder({ label: 'jacobian' });
    const pass = encoder.beginComputePass();
    pass.setPipeline(this.jacobianPipeline);
    pass.setBindGroup(0, this.jacobianBindGroup);
    pass.dispatchWorkgroups(Math.ceil(this.numFaces / 64));
    pass.end();
    this.device.queue.submit([encoder.finish()]);
  }

  /**
   * Lazily build the vert-transform pipeline. Only the gpu-resident rig path
   * (`setPoseGpu`) needs it; a CPU-verts backend never calls it.
   *
   * @returns The pass and its bindings, built on the first call and reused after that.
   */
  private ensureTransformPipeline(): TransformPass {
    const existing = this.transform;
    if (existing) return existing;
    const device = this.device;
    const pipeline = device.createComputePipeline({
      label: 'character_vert_transform',
      layout: 'auto',
      compute: {
        module: device.createShaderModule({ code: vertTransformWgsl }),
        entryPoint: 'main',
      },
    });
    const params = device.createBuffer({
      label: 'vert_transform_params',
      size: VERT_TRANSFORM_PARAMS_BYTES,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    // A bind group must be complete even when no correction is installed, so binding 2
    // starts as a 3-float dummy the shader never reads (useCorr = 0).
    const corr = device.createBuffer({
      label: 'vert_transform_corr_dummy',
      size: 12,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    const pass: TransformPass = {
      pipeline,
      params,
      corr,
      bindGroup: this.buildTransformBindGroup(pipeline, params, corr),
    };
    this.transform = pass;
    return pass;
  }

  private buildTransformBindGroup(
    pipeline: GPUComputePipeline,
    params: GPUBuffer,
    corr: GPUBuffer,
  ): GPUBindGroup {
    return this.device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.bufVerts } },
        { binding: 1, resource: { buffer: params } },
        { binding: 2, resource: { buffer: corr } },
      ],
    });
  }

  private writeTransformParams(pass: TransformPass): void {
    this.device.queue.writeBuffer(
      pass.params,
      0,
      packVertTransformParams(this.deformLin, this.deformOffset, this.numVerts, this.useVertCorr),
    );
  }

  /**
   * The rig -> checkpoint transform applied by `setPoseGpu`: a 3x3 (ROW-major,
   * applied as the row-vector product `v·M`) plus a translation. Call once, after
   * calibration has fitted it.
   *
   * A full 3x3 rather than a scale, because the mapping carries a ROTATION that a
   * scale cannot express and a per-vertex `corr` can only hide at the anchor pose.
   *
   * @param lin The 9-float ROW-major linear part; anything shorter falls back to the
   *   identity rather than to zeros.
   * @param offset The translation in checkpoint units; missing components read as 0.
   */
  setDeformLinear(lin: ArrayLike<number>, offset: ArrayLike<number>): void {
    if (this.destroyed) return;
    const pass = this.ensureTransformPipeline();
    // A short `lin` falls back to the identity rather than to zeros: an all-zero row
    // collapses every vertex onto a plane, which is not a pose anyone would recognise
    // as a bad transform.
    this.deformLin = Array.from({ length: 9 }, (_, i) =>
      i < lin.length ? lin[i] : i % 4 === 0 ? 1 : 0,
    );
    this.deformOffset = [
      offset.length > 0 ? offset[0] : 0,
      offset.length > 1 ? offset[1] : 0,
      offset.length > 2 ? offset[2] : 0,
    ];
    this.writeTransformParams(pass);
  }

  /**
   * Install a PER-VERTEX anchor correction (`V*3` floats), added by `setPoseGpu`'s
   * transform pass: `v' = v·M + offset + corr[i]`. This is how a branch anchors its
   * rig to its baked neutral (`corr = neutral - M·rig(baseRig)`); a scalar mean
   * offset there scatters splats. Uploaded ONCE at calibration. Null removes it.
   *
   * @param corr The `V*3` residual as flat xyz triples, or `null` to drop the correction.
   *   Anything past this branch's vertex count is ignored.
   */
  setVertCorrection(corr: Float32Array | null): void {
    if (this.destroyed) return;
    const pass = this.ensureTransformPipeline();
    if (!corr) {
      this.useVertCorr = false;
      this.writeTransformParams(pass);
      return;
    }
    if (corr.length < this.numVerts * 3) {
      throw new Error(
        `GpuLifter.setVertCorrection: got ${String(corr.length / 3)} verts, mesh has ${String(this.numVerts)}`,
      );
    }
    const bytes = this.numVerts * 3 * 4;
    if (!this.bufVertCorrOwned || pass.corr.size < bytes) {
      pass.corr.destroy();
      pass.corr = this.device.createBuffer({
        label: 'vert_transform_corr',
        size: bytes,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      });
      this.bufVertCorrOwned = true;
      pass.bindGroup = this.buildTransformBindGroup(pass.pipeline, pass.params, pass.corr);
    }
    writeView(this.device, pass.corr, 0, corr.subarray(0, this.numVerts * 3));
    this.useVertCorr = true;
    this.writeTransformParams(pass);
  }

  /**
   * GPU-resident pose path: `verts` is the rig backend's own output buffer.
   * Copies it into `bufVerts` (no readback / re-upload), applies the
   * scale+rotation+offset transform in place, then computes jacobians — all RECORDED
   * into the caller's encoder. Requires `setDeformLinear` to have run.
   *
   * It used to create and submit an encoder of its own, once per branch per frame,
   * which is what made "one submission per update" false by a factor of three.
   *
   * @param verts The rig backend's own output buffer of flat xyz triples, in RIG space.
   * @param verts.gpuBuffer The buffer to copy from; it must live on this lifter's device.
   * @param verts.byteLength How much of it is written; the copy is clamped to whichever of
   *   this and the destination is smaller, since a producer may over-allocate.
   * @param encoder The frame's command encoder, recorded into but never submitted here.
   */
  setPoseGpu(
    verts: { gpuBuffer: GPUBuffer; byteLength: number },
    encoder: GPUCommandEncoder,
  ): void {
    if (this.destroyed) return;
    const pass = this.ensureTransformPipeline();
    // The producer may over-allocate, so clamp the span.
    encoder.copyBufferToBuffer(
      verts.gpuBuffer,
      0,
      this.bufVerts,
      0,
      Math.min(verts.byteLength, this.bufVerts.size),
    );
    {
      const p = encoder.beginComputePass({ label: 'vert_transform' });
      p.setPipeline(pass.pipeline);
      p.setBindGroup(0, pass.bindGroup);
      p.dispatchWorkgroups(Math.ceil(this.numVerts / 64));
      p.end();
    }
    {
      const p = encoder.beginComputePass({ label: 'jacobian' });
      p.setPipeline(this.jacobianPipeline);
      p.setBindGroup(0, this.jacobianBindGroup);
      p.dispatchWorkgroups(Math.ceil(this.numFaces / 64));
      p.end();
    }
  }

  /**
   * Lift the decoder's UV maps into this branch's slots, RECORDED into `encoder`.
   *
   * Nothing is read back, so there is no fence to await. One device means one queue
   * and WebGPU executes submissions in order, so the renderer's next frame provably
   * reads finished output.
   *
   * `skipGeomUpload` is the appearance-only hot path: on a camera-only pass the geom
   * decoder never re-ran, so `geomUv` is literally the array the last full pass
   * uploaded and re-sending 11 floats per texel (11 MB on a 750² head) buys nothing.
   * It is NOT a blanket "skip both": `colorUv` is exactly what an appearance pass
   * just recomputed, and skipping that would freeze the colour.
   *
   * @param geomUv The geom decoder's UV map — a CPU `Float32Array`, which is uploaded, or a
   *   gpu-buffer input on the shared ORT device, which is copied inside the encoder.
   * @param colorUv The appearance decoder's UV map, in either of the same two forms.
   * @param encoder The frame's command encoder, recorded into but never submitted here.
   * @param opts Options for this dispatch.
   * @param opts.skipGeomUpload Skip the geometry upload because the caller knows the same
   *   CPU array is already resident. Has no effect on a gpu-buffer input, whose copy is
   *   recorded either way.
   */
  lift(
    geomUv: LiftInput,
    colorUv: LiftInput,
    encoder: GPUCommandEncoder,
    opts: { skipGeomUpload?: boolean } = {},
  ): void {
    if (this.destroyed) return;
    const device = this.device;
    // CPU inputs are writeBuffer'd up; gpu-buffer inputs (the shared ORT device)
    // are copyBufferToBuffer'd INSIDE the encoder, so the copy sequences before
    // pass 1 reads them with no CPU round-trip.
    if (geomUv instanceof Float32Array && !opts.skipGeomUpload) {
      writeView(device, this.bufGeomUv, 0, geomUv);
    }
    if (colorUv instanceof Float32Array) {
      writeView(device, this.bufColorUv, 0, colorUv);
    }
    if (!(geomUv instanceof Float32Array)) {
      encoder.copyBufferToBuffer(
        geomUv.gpuBuffer,
        0,
        this.bufGeomUv,
        0,
        Math.min(geomUv.byteLength, this.bufGeomUv.size),
      );
    }
    if (!(colorUv instanceof Float32Array)) {
      encoder.copyBufferToBuffer(
        colorUv.gpuBuffer,
        0,
        this.bufColorUv,
        0,
        Math.min(colorUv.byteLength, this.bufColorUv.size),
      );
    }
    {
      const p = encoder.beginComputePass({ label: 'pass1' });
      p.setPipeline(this.pass1Pipeline);
      p.setBindGroup(0, this.pass1BindGroup);
      p.dispatchWorkgroups(Math.ceil(this.hw / 64));
      p.end();
    }
    {
      const p = encoder.beginComputePass({ label: 'pass2' });
      p.setPipeline(this.pass2Pipeline);
      p.setBindGroup(0, this.pass2BindGroup);
      p.setBindGroup(1, this.sinkBindGroup);
      p.dispatchWorkgroups(Math.ceil(this.hw / 64));
      p.end();
    }
  }

  /**
   * Approximate GPU bytes this lifter owns, for `memoryReport()`.
   *
   * @returns The summed size of every buffer allocated here. The sink's own buffers are not
   *   counted, since this lifter only borrows them.
   */
  bytes(): number {
    const own = [
      this.bufFaces,
      this.bufIdxim,
      this.bufBarim,
      this.bufTriim,
      this.bufValid,
      this.bufVerts,
      this.bufJacobians,
      this.bufFaceValid,
      this.bufGeomUv,
      this.bufColorUv,
      this.bufPass1Out,
      this.bufMaskData,
      this.transform?.corr,
    ];
    return own.reduce((total, buffer) => total + (buffer?.size ?? 0), 0);
  }

  /** Release every buffer this lifter owns. The sink's buffers are not ours. */
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    const all = [
      this.bufFaces,
      this.bufIdxim,
      this.bufBarim,
      this.bufTriim,
      this.bufValid,
      this.bufVerts,
      this.bufJacobians,
      this.bufFaceValid,
      this.bufGeomUv,
      this.bufColorUv,
      this.bufPass1Out,
      this.bufJacobianDims,
      this.bufLiftDims,
      this.bufPlacement,
      this.transform?.params,
      this.transform?.corr,
      this.bufMaskParams,
      this.bufMaskData,
    ];
    for (const b of all) b?.destroy();
  }
}
