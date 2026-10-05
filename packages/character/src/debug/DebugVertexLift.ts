// The rig, visible, with no decoders in the building.
//
// `DebugVertexLift` is a second consumer of `RigBackend.vertsBuffer` that writes one
// small isotropic gaussian per vertex into a `SplatSink` slot range. It binds the same
// four sink buffers in the same order as `lift_pass2_cov.wgsl` and addresses slots the
// same way (`slot_offset + i`, fixed for life), so a preview exercises the real buffer
// contract — the part of the chain a unit test cannot reach and a missing decoder
// otherwise hides completely.
//
// WHAT IT PROVES, and what it does not. It proves that a rig backend initialised, that
// its pack parsed, that its compute pass ran on the renderer's own device, that the
// vertices are finite and in the frame and units the caller thinks they are, and that
// the sink's slots, sort and bounds all work. It proves NOTHING about appearance:
// there is no opacity model, no view dependence and no covariance from the model.
//
// EVERY PER-FRAME BUFFER WRITE IS CONDITIONAL. `sigma`, the transform and the shading
// mode change when a slider moves, not every frame, so the 96-byte uniform is uploaded
// only when one of them is dirty. The per-vertex tint is uploaded once.

import { debugVertexLiftWgsl } from '../generated/index.js';
import type { SlotRange, SplatSink } from '../splatSink.js';
import type { VertsAABB } from '../rig/RigBackend.js';

/** Threads per workgroup in `debug_vertex_lift.wgsl`. Mirrors the shader's literal. */
export const DEBUG_LIFT_WORKGROUP = 64;

/** Bytes of the params uniform: four u32, three vec4 rows, four f32, one vec4. */
export const DEBUG_LIFT_PARAMS_BYTES = 96;

/** How the shader colours a vertex. */
export type DebugShading = 'tint' | 'normal' | 'flat';

/** The shading mode's wire value, which is what the shader switches on. */
const SHADING_CODE: Record<DebugShading, number> = { tint: 0, normal: 1, flat: 2 };

/** Everything the params uniform carries. */
export interface DebugLiftParams {
  /** Vertices in the rig buffer. Slots past this are cleared, not skipped. */
  vertexCount: number;
  /** First slot of the range this preview owns. */
  slotOffset: number;
  /** Slots the range owns. */
  slotCount: number;
  /** Colour source. */
  shading: DebugShading;
  /** Rig -> sink-object affine, row-major 3x4 (12 numbers). */
  transform: readonly number[];
  /** Gaussian radius in object space, metres. */
  sigma: number;
  /** Alpha written into every gaussian, `[0, 1]`. */
  opacity: number;
  /** Object-space centre the `normal` shading points away from. */
  centroid: readonly [number, number, number];
}

/** The identity 3x4, row-major: a rig whose vertices are already in object space. */
export const IDENTITY_3X4: readonly number[] = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0];

/**
 * Dispatch size for a slot range.
 *
 * @param slotCount Slots the preview owns.
 * @returns Workgroups to dispatch — every slot is visited, including the ones past the
 *   vertex count, because those have to be cleared rather than left stale.
 *
 * @example
 * ```ts
 * import { debugLiftDispatch } from 'gameable/character';
 *
 * console.log(debugLiftDispatch(17_821)); // 279
 * ```
 */
export function debugLiftDispatch(slotCount: number): number {
  return Math.ceil(slotCount / DEBUG_LIFT_WORKGROUP);
}

/**
 * Pack the params uniform.
 *
 * Separate from the class so the byte layout can be asserted in a node test — a
 * mis-packed uniform is a head at the wrong scale or in the wrong place, with no error
 * anywhere.
 *
 * @param params The values to write.
 * @param into An existing 96-byte buffer to fill. A fresh one is allocated when omitted,
 *   which the per-frame path never does.
 * @returns The buffer, filled.
 * @throws {RangeError} When `transform` is not 12 numbers, or `into` is the wrong size.
 */
export function writeDebugLiftParams(params: DebugLiftParams, into?: ArrayBuffer): ArrayBuffer {
  if (params.transform.length !== 12) {
    throw new RangeError(
      `debug lift: transform must be 12 numbers (row-major 3x4), got ${String(params.transform.length)}`,
    );
  }
  const buffer = into ?? new ArrayBuffer(DEBUG_LIFT_PARAMS_BYTES);
  if (buffer.byteLength !== DEBUG_LIFT_PARAMS_BYTES) {
    throw new RangeError(
      `debug lift: params buffer must be ${String(DEBUG_LIFT_PARAMS_BYTES)} bytes, got ${String(buffer.byteLength)}`,
    );
  }
  const u32 = new Uint32Array(buffer);
  const f32 = new Float32Array(buffer);
  u32[0] = params.vertexCount;
  u32[1] = params.slotOffset;
  u32[2] = params.slotCount;
  u32[3] = SHADING_CODE[params.shading];
  for (let i = 0; i < 12; i++) f32[4 + i] = params.transform[i];
  f32[16] = params.sigma;
  f32[17] = params.opacity;
  f32[18] = 0;
  f32[19] = 0;
  f32[20] = params.centroid[0];
  f32[21] = params.centroid[1];
  f32[22] = params.centroid[2];
  f32[23] = 0;
  return buffer;
}

/**
 * A rig -> object transform that centres the vertices and scales them to a target size.
 *
 * The two rigs disagree about units (GNM metres, ORL centimetres) and neither puts a
 * head anywhere near the origin, so a preview that did not normalise would render off
 * screen at the wrong size and look like a failure. This is a VIEWING convenience and
 * nothing downstream depends on it.
 *
 * @param aabb The backend's neutral-pose bounds, in its own units.
 * @param options Placement overrides.
 * @param options.height Object-space height the bounds are scaled to. Defaults to 0.35 m,
 *   a head at conversational distance.
 * @param options.scale A uniform scale, overriding `height` outright.
 * @param options.offset Where the fitted centre lands. Defaults to the origin.
 * @returns A row-major 3x4 affine, ready for {@link DebugLiftParams.transform}, plus the
 *   scale it chose and the object-space centroid the `normal` shading needs.
 */
export function fitVertsTransform(
  aabb: VertsAABB,
  options: {
    height?: number;
    scale?: number;
    offset?: readonly [number, number, number];
  } = {},
): { transform: number[]; scale: number; centroid: [number, number, number] } {
  const span = [
    aabb.max[0] - aabb.min[0],
    aabb.max[1] - aabb.min[1],
    aabb.max[2] - aabb.min[2],
  ] as const;
  const tallest = Math.max(span[0], span[1], span[2]);
  const scale = options.scale ?? (tallest > 1e-9 ? (options.height ?? 0.35) / tallest : 1);
  const mid = [
    (aabb.max[0] + aabb.min[0]) / 2,
    (aabb.max[1] + aabb.min[1]) / 2,
    (aabb.max[2] + aabb.min[2]) / 2,
  ] as const;
  const offset = options.offset ?? [0, 0, 0];
  const transform = [
    scale,
    0,
    0,
    offset[0] - mid[0] * scale,
    0,
    scale,
    0,
    offset[1] - mid[1] * scale,
    0,
    0,
    scale,
    offset[2] - mid[2] * scale,
  ];
  return { transform, scale, centroid: [offset[0], offset[1], offset[2]] };
}

/** What {@link DebugVertexLift} needs at construction. */
export interface DebugVertexLiftOptions {
  /** The renderer's own device — the one the rig backend built its buffers on. */
  device: GPUDevice;
  /** Where the gaussians go. */
  sink: SplatSink;
  /** The rig's posed vertices, `V * 3` f32 in the rig's own units. */
  vertsBuffer: GPUBuffer;
  /** How many vertices that buffer holds. */
  vertexCount: number;
  /**
   * A range to write into. Omit and the lift allocates `vertexCount` slots from the sink
   * and frees them on `dispose`.
   */
  range?: SlotRange;
  /** One packed RGBA per vertex, from `vertexTint.ts`. Defaults to a flat neutral. */
  tint?: Uint32Array;
  /** Colour source. Defaults to `tint`. */
  shading?: DebugShading;
  /** Gaussian radius in object space, metres. Defaults to 2 mm. */
  sigma?: number;
  /** Alpha of every gaussian. Defaults to 1. */
  opacity?: number;
  /** Rig -> object affine, row-major 3x4. Defaults to the identity. */
  transform?: readonly number[];
  /** Object-space centre for `normal` shading. Defaults to the origin. */
  centroid?: readonly [number, number, number];
  /** Label prefix for the GPU objects, so a capture is readable. */
  label?: string;
}

/**
 * One isotropic gaussian per rig vertex, in a sink's slot range.
 *
 * @example
 * ```ts
 * import { DebugVertexLift } from 'gameable/character';
 *
 * const lift = new DebugVertexLift({
 *   device,
 *   sink,
 *   vertsBuffer: backend.vertsBuffer,
 *   vertexCount: backend.vertexCount,
 * });
 * const encoder = device.createCommandEncoder();
 * backend.encode(encoder);
 * lift.encode(encoder);
 * device.queue.submit([encoder.finish()]);
 * sink.markGaussiansChanged();
 * ```
 */
export class DebugVertexLift {
  /** The slots this preview owns. Fixed for its lifetime. */
  readonly range: SlotRange;
  /** Vertices it draws. */
  readonly vertexCount: number;

  readonly #device: GPUDevice;
  readonly #sink: SplatSink;
  readonly #pipeline: GPUComputePipeline;
  readonly #bindGroup0: GPUBindGroup;
  readonly #bindGroup1: GPUBindGroup;
  readonly #tintBuffer: GPUBuffer;
  readonly #paramsBuffer: GPUBuffer;
  readonly #scratch = new ArrayBuffer(DEBUG_LIFT_PARAMS_BYTES);
  readonly #ownsRange: boolean;
  readonly #params: DebugLiftParams;
  #dirty = true;
  #disposed = false;

  /**
   * Build the pipeline and reserve the slots.
   *
   * @param options See {@link DebugVertexLiftOptions}.
   * @throws {RangeError} When the supplied range is smaller than the vertex count, which
   *   would silently draw part of a head.
   */
  constructor(options: DebugVertexLiftOptions) {
    const label = options.label ?? 'debug_vertex_lift';
    this.#device = options.device;
    this.#sink = options.sink;
    this.vertexCount = options.vertexCount;
    this.#ownsRange = options.range === undefined;
    this.range = options.range ?? options.sink.allocate(options.vertexCount);
    if (this.range.count < options.vertexCount) {
      throw new RangeError(
        `debug lift: the range holds ${String(this.range.count)} slots but the rig has ` +
          `${String(options.vertexCount)} vertices`,
      );
    }

    this.#params = {
      vertexCount: options.vertexCount,
      slotOffset: this.range.offset,
      slotCount: this.range.count,
      shading: options.shading ?? 'tint',
      transform: options.transform ?? IDENTITY_3X4,
      sigma: options.sigma ?? 0.002,
      opacity: options.opacity ?? 1,
      centroid: options.centroid ?? [0, 0, 0],
    };

    const module = this.#device.createShaderModule({ code: debugVertexLiftWgsl, label });
    this.#pipeline = this.#device.createComputePipeline({
      layout: 'auto',
      compute: { module, entryPoint: 'main' },
    });

    const tint = options.tint ?? new Uint32Array(options.vertexCount).fill(0xffe6e6d9);
    this.#tintBuffer = this.#device.createBuffer({
      label: `${label}:tint`,
      size: Math.max(4, tint.byteLength),
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    this.#device.queue.writeBuffer(
      this.#tintBuffer,
      0,
      tint.buffer,
      tint.byteOffset,
      tint.byteLength,
    );

    this.#paramsBuffer = this.#device.createBuffer({
      label: `${label}:params`,
      size: DEBUG_LIFT_PARAMS_BYTES,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    this.#bindGroup0 = this.#device.createBindGroup({
      label: `${label}:rig`,
      layout: this.#pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: options.vertsBuffer } },
        { binding: 1, resource: { buffer: this.#tintBuffer } },
        { binding: 2, resource: { buffer: this.#paramsBuffer } },
      ],
    });
    this.#bindGroup1 = this.#device.createBindGroup({
      label: `${label}:sink`,
      layout: this.#pipeline.getBindGroupLayout(1),
      entries: [
        { binding: 0, resource: { buffer: options.sink.buffers.center } },
        { binding: 1, resource: { buffer: options.sink.buffers.covarianceA } },
        { binding: 2, resource: { buffer: options.sink.buffers.covarianceB } },
        { binding: 3, resource: { buffer: options.sink.buffers.color } },
      ],
    });
  }

  /**
   * The params as they will next be uploaded. Read-only; use the setters.
   *
   * @returns The current parameters.
   */
  get params(): Readonly<DebugLiftParams> {
    return this.#params;
  }

  /**
   * Change the gaussian radius.
   *
   * @param sigma Radius in object space, metres.
   */
  setSigma(sigma: number): void {
    this.#params.sigma = sigma;
    this.#dirty = true;
  }

  /**
   * Change the colour source.
   *
   * @param shading `tint`, `normal` or `flat`.
   */
  setShading(shading: DebugShading): void {
    this.#params.shading = shading;
    this.#dirty = true;
  }

  /**
   * Change the rig -> object placement.
   *
   * @param transform Row-major 3x4 affine, 12 numbers.
   * @param centroid Object-space centre for `normal` shading. Left alone when omitted.
   */
  setTransform(transform: readonly number[], centroid?: readonly [number, number, number]): void {
    this.#params.transform = transform;
    if (centroid) this.#params.centroid = centroid;
    this.#dirty = true;
  }

  /**
   * Record the pass. The rig's own pass must already be in this encoder, or an earlier
   * submission: one device means one queue, so ordering alone is the synchronisation.
   *
   * @param encoder The frame's encoder.
   */
  encode(encoder: GPUCommandEncoder): void {
    if (this.#disposed) throw new Error('DebugVertexLift: already disposed');
    if (this.#dirty) {
      writeDebugLiftParams(this.#params, this.#scratch);
      this.#device.queue.writeBuffer(this.#paramsBuffer, 0, this.#scratch);
      this.#dirty = false;
    }
    const pass = encoder.beginComputePass({ label: 'debug_vertex_lift' });
    pass.setPipeline(this.#pipeline);
    pass.setBindGroup(0, this.#bindGroup0);
    pass.setBindGroup(1, this.#bindGroup1);
    pass.dispatchWorkgroups(debugLiftDispatch(this.range.count));
    pass.end();
  }

  /** Release the GPU buffers and, when it allocated the range, the slots. Idempotent. */
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#tintBuffer.destroy();
    this.#paramsBuffer.destroy();
    if (this.#ownsRange) this.#sink.free(this.range);
  }
}
