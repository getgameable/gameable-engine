// A rig backend plus a debug lift plus a sink, wired up — the whole "look at the rig"
// path in one call.
//
// `createCharacter` is the real entry point and it needs a bundle: meshes, geometry and
// appearance decoders, a calibration, an expression space. A rig backend needs none of
// that — an `.aosrig` pack or an ORL DNA is enough to pose vertices — and during a port
// the rig is ready months before the decoders are retrained on its topology. This is the
// smaller door: a backend, a sink, and one gaussian per vertex.
//
// IT IS A DEVELOPMENT TOOL and it says so at the seams: the placement is a convenience
// fit rather than the bundle's calibrated transform, the colours are regions rather than
// appearance, and nothing here is on a shipping character's path.

import { DebugVertexLift, fitVertsTransform, type DebugShading } from './DebugVertexLift.js';
import { prepareLiftDevice, type RendererLike } from '../device/index.js';
import type { RigBackend } from '../rig/RigBackend.js';
import type { SlotRange, SplatSink } from '../splatSink.js';

/** What {@link createRigPreview} takes. */
export interface CreateRigPreviewOptions {
  /** The engine's renderer. Either this or `device`; the renderer owns the device. */
  renderer?: RendererLike;
  /** The device, when the caller already has it from `prepareLiftDevice`. */
  device?: GPUDevice;
  /** Where the gaussians go — an `AnimatedSplat` from `@gameable/splat`. */
  sink: SplatSink;
  /** The backend to preview. Constructed, not necessarily initialised. */
  backend: RigBackend;
  /**
   * Bundle-relative file bytes. Supply them and the preview calls `backend.init` itself;
   * omit them and the backend is assumed to be initialised already.
   */
  getBytes?: (name: string) => Uint8Array | undefined;
  /** Lazily fetch a file the eager pass skipped, handed to `backend.init`. */
  fetchBytes?: (name: string) => Promise<Uint8Array>;
  /** Control names for `backend.init`. Defaults to none, which GNM does not need. */
  controlNames?: string[];
  /** One packed RGBA per vertex; see `vertexTint.ts`. */
  tint?: Uint32Array;
  /** Colour source. Defaults to `tint` when a tint is supplied, `normal` otherwise. */
  shading?: DebugShading;
  /** Gaussian radius in object space, metres. Defaults to 2 mm. */
  sigma?: number;
  /** Object-space height the rig's bounds are scaled to. Defaults to 0.35 m. */
  height?: number;
  /** Object-space position of the fitted centre. Defaults to the origin. */
  offset?: readonly [number, number, number];
  /** An explicit rig -> object affine (row-major 3x4), instead of the fit. */
  transform?: readonly number[];
  /** Slots to draw into. Defaults to a fresh allocation of `vertexCount`. */
  range?: SlotRange;
  /** Set the sink's bounding sphere from the fitted bounds. Defaults to true. */
  setBounds?: boolean;
}

/** A live rig preview. */
export interface RigPreview {
  /** The backend, initialised. */
  readonly backend: RigBackend;
  /** The debug lift, for `setSigma` / `setShading` / `setTransform`. */
  readonly lift: DebugVertexLift;
  /** The slots the preview owns. */
  readonly range: SlotRange;
  /** Uniform scale the placement fit chose, for an overlay to report. */
  readonly scale: number;

  /**
   * Solve the rig at `controls` — the backend's own control space, so `head_ext` for GNM.
   *
   * @param controls The control vector.
   */
  setControls(controls: Float32Array): void;

  /**
   * Record the rig pass and the debug lift into one encoder, in that order.
   *
   * Use this when the caller owns the submission — a frame that also wants timestamp
   * queries around the two passes, for instance.
   *
   * @param encoder The frame's command encoder.
   */
  encode(encoder: GPUCommandEncoder): void;

  /**
   * Encode, submit and ask the sink to re-sort. The one-call-per-frame path.
   */
  render(): void;

  /** Release the lift's buffers, the backend's resources and the slot range. */
  dispose(): void;
}

/**
 * Put a rig backend on screen without any decoders.
 *
 * @param options See {@link CreateRigPreviewOptions}.
 * @returns The live preview.
 * @throws {CharacterUnsupportedError} When the renderer is on the WebGL fallback.
 *
 * @example
 * ```ts
 * import { createRigPreview, GnmRigBackend, jointTint } from 'gameable/character';
 *
 * const preview = await createRigPreview({
 *   renderer,
 *   sink: splat,
 *   backend: new GnmRigBackend({ packFile: 'myra_head.aosrig' }),
 *   getBytes: (name) => files.get(name),
 * });
 * preview.setControls(headExt);
 * preview.render();
 * ```
 */
export async function createRigPreview(options: CreateRigPreviewOptions): Promise<RigPreview> {
  const device =
    options.device ??
    prepareLiftDevice(
      options.renderer ??
        (() => {
          throw new Error('createRigPreview: pass either `renderer` or `device`');
        })(),
    );

  const backend = options.backend;
  if (options.getBytes) {
    await backend.init({
      device,
      getBytes: options.getBytes,
      fetchBytes: options.fetchBytes,
      controlNames: options.controlNames ?? [],
    });
  }

  const fit = fitVertsTransform(backend.vertsAABB, {
    height: options.height,
    offset: options.offset,
  });
  const transform = options.transform ?? fit.transform;

  const lift = new DebugVertexLift({
    device,
    sink: options.sink,
    vertsBuffer: backend.vertsBuffer,
    vertexCount: backend.vertexCount,
    range: options.range,
    tint: options.tint,
    shading: options.shading ?? (options.tint ? 'tint' : 'normal'),
    sigma: options.sigma,
    transform,
    centroid: fit.centroid,
  });

  if (options.setBounds !== false) {
    // A generous radius: the fit covers the NEUTRAL pose, and an expression moves
    // vertices past it. The sort quantises depth across this sphere, so being 20% wide
    // costs a little precision; being too small clips the head out of the sort entirely.
    const span = [
      backend.vertsAABB.max[0] - backend.vertsAABB.min[0],
      backend.vertsAABB.max[1] - backend.vertsAABB.min[1],
      backend.vertsAABB.max[2] - backend.vertsAABB.min[2],
    ];
    const radius = 0.6 * Math.hypot(span[0], span[1], span[2]) * fit.scale * 1.2;
    options.sink.setBoundingSphere(
      [fit.centroid[0], fit.centroid[1], fit.centroid[2]],
      Math.max(radius, 1e-3),
    );
  }

  return {
    backend,
    lift,
    range: lift.range,
    scale: fit.scale,
    setControls(controls) {
      backend.setControls(controls);
    },
    encode(encoder) {
      backend.encode(encoder);
      lift.encode(encoder);
    },
    render() {
      const encoder = device.createCommandEncoder({ label: 'rig_preview' });
      backend.encode(encoder);
      lift.encode(encoder);
      device.queue.submit([encoder.finish()]);
      options.sink.markGaussiansChanged();
    },
    dispose() {
      lift.dispose();
      backend.dispose();
    },
  };
}
