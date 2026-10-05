// The ONE device decision, so the decoders, the rig deform and the lift cannot
// disagree about which GPU owns a buffer.
//
// THE ORDER IS LOAD-BEARING, and it is the whole reason this file is separate
// from everything that uses a device:
//
//   initWebGPUPatches()          (gameable/core, before the renderer exists)
//   renderer.init()              -> renderer.backend.device
//   prepareLiftDevice(renderer)  -> assert limits, hand back that device
//   attachOrtDevice(device)      -> ort.env.webgpu.device = device
//   ...first ONNX session create...
//   new GpuLifter(device, ...)   -> pipelines on the same device
//
// ORT-Web caches its device on the FIRST WebGPU session create. Setting
// `env.webgpu.device` after that point is silently ignored, ORT builds its own,
// and every `copyBufferToBuffer` between a decoder output and the lift throws
// "Buffer is associated with [Device]". So this must run before any session is
// built — which is why `attachOrtDevice` reports whether it was in time rather
// than assuming.
//
// NOTHING HERE CALLS `navigator.gpu.requestAdapter()`. The renderer owns the
// device; everything else borrows it. The POC did request its own (it had to —
// its renderer was WebGL), and the cross-device demote path that produced is the
// `DownloadOutputs` fallback kept below.
//
// Replaces aos-threejs-poc/src/ogs/inference/gpuDevice.ts @ cdd63b10.

import { CharacterUnsupportedError } from '../errors.js';

/**
 * WebGPU's DEFAULT `maxStorageBuffersPerShaderStage`, which every adapter grants.
 * The lift's heaviest pass (`lift_pass1.wgsl`) binds exactly 8, so no device is
 * refused the lift over a limit. It bound 9 until `valid` was folded into `triim`
 * (`inference/liftTriim.ts`), and the integrated GPUs that report exactly 8 were
 * silently landing on a seconds-per-frame CPU path.
 */
export const REQUIRED_STORAGE_BUFFERS = 8;

/** The shape of `renderer.backend` this package reads. Nothing else is touched. */
interface BackendLike {
  device?: GPUDevice;
  isWebGPUBackend?: boolean;
}

/** The slice of `WebGPURenderer` this package reads. */
export interface RendererLike {
  // A bare `object`, narrowed in `prepareLiftDevice`, NOT `BackendLike`. three's own
  // `Backend` class declares neither `device` nor `isWebGPUBackend` in its public types —
  // the WebGPU subclass sets them at runtime — so a structural `BackendLike` shares no
  // property with it and TypeScript refuses a REAL `WebGPURenderer` with "no properties in
  // common", which is the one argument this interface exists to accept. A test double
  // stays assignable either way.
  backend?: object;
}

/**
 * The `GPUDevice` a character's compute runs on: the renderer's own.
 *
 * Throws `CharacterUnsupportedError` when the renderer is on the WebGL fallback
 * backend or has not been initialised, because there is then no device to borrow
 * and no CPU path to demote to.
 *
 * @param renderer The engine's `WebGPURenderer`, already `init()`ed; only
 * `backend.device` and `backend.isWebGPUBackend` are read.
 * @returns The renderer's own device, confirmed to grant at least
 * {@link REQUIRED_STORAGE_BUFFERS} storage buffers per shader stage.
 *
 * @example
 * ```ts
 * import { attachOrtDevice, prepareLiftDevice } from 'gameable/character';
 *
 * await renderer.init();
 * const device = prepareLiftDevice(renderer);
 * attachOrtDevice(device); // before the first ONNX session
 * ```
 */
export function prepareLiftDevice(renderer: RendererLike): GPUDevice {
  const backend = renderer.backend as BackendLike | undefined;
  if (!backend) {
    throw new CharacterUnsupportedError('the renderer has no backend — call renderer.init() first');
  }
  const device = backend.device;
  if (!device) {
    if (backend.isWebGPUBackend !== true) {
      throw new CharacterUnsupportedError('the renderer is on the WebGL fallback backend');
    }
    throw new CharacterUnsupportedError(
      'renderer.backend.device is not set — call `await renderer.init()` before creating a character',
    );
  }
  const granted = device.limits.maxStorageBuffersPerShaderStage;
  if (granted < REQUIRED_STORAGE_BUFFERS) {
    throw new CharacterUnsupportedError(
      `this device grants maxStorageBuffersPerShaderStage=${String(granted)}; the lift binds ` +
        `${String(REQUIRED_STORAGE_BUFFERS)}, which is the WebGPU default. Raise it in the renderer's ` +
        'device request (@gameable/core initWebGPUPatches).',
    );
  }
  return device;
}
