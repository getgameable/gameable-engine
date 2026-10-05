/**
 * WebGPU device patches, applied once at boot.
 *
 * The engine never calls `navigator.gpu.requestAdapter()` itself — the renderer
 * owns the `GPUDevice` and everything else borrows `renderer.backend.device`.
 * But three, and onnxruntime-web when characters are in play, each request a
 * device with their own descriptor, and the first one to ask wins. The device
 * they get must already have the limits the lift pipelines need, because limits
 * cannot be raised afterwards.
 *
 * So `GPUAdapter.prototype.requestDevice` is patched at boot, before anything
 * creates a device. The patch is **additive**: it raises
 * `maxStorageBuffersPerShaderStage` and never lowers it, merges the caller's
 * descriptor rather than replacing it, and is a no-op on hosts without WebGPU.
 *
 * Ported from `aos-threejs-poc/src/lib/webgpuLimits.js`.
 */

/** Storage buffers per shader stage the engine asks for. The WebGPU default is 8. */
export const DEFAULT_MAX_STORAGE_BUFFERS_PER_SHADER_STAGE = 10;

/** Assumed adapter limit when an adapter does not report one. */
const WEBGPU_DEFAULT_STORAGE_BUFFERS = 8;

/** Marker and state holder, kept on the patched prototype. */
const PATCH_STATE = Symbol.for('gameable.webgpu.patchState');

/** The parts of `GPUAdapter` the patch touches. */
export interface PatchableAdapterPrototype {
  /**
   * The method being wrapped.
   *
   * @param descriptor Device descriptor, as the caller wrote it.
   * @returns The requested device.
   */
  requestDevice(descriptor?: GPUDeviceDescriptor): Promise<GPUDevice>;
}

/** Options accepted by {@link initWebGPUPatches}. */
export interface WebGPUPatchOptions {
  /**
   * Storage buffers per shader stage to ask for.
   *
   * The patch requests `min(this, adapter.limits.maxStorageBuffersPerShaderStage)`,
   * so asking for more than the adapter has is harmless. Defaults to
   * {@link DEFAULT_MAX_STORAGE_BUFFERS_PER_SHADER_STAGE}.
   */
  readonly maxStorageBuffersPerShaderStage?: number;
  /**
   * Also request the `timestamp-query` feature when the adapter has it.
   *
   * Needed to time GPU passes in the debug overlay and the benchmarks. Off by
   * default, because the feature has a cost.
   */
  readonly timestampQuery?: boolean;
  /**
   * Prototype to patch. Defaults to the global `GPUAdapter.prototype`.
   *
   * Tests pass a fake here; production never sets it.
   */
  readonly target?: PatchableAdapterPrototype;
}

/** Mutable state the patched method reads on every call. */
interface PatchState {
  /** Highest storage-buffer count requested so far. */
  maxStorageBuffersPerShaderStage: number;
  /** Whether any caller asked for `timestamp-query`. */
  timestampQuery: boolean;
}

/**
 * The global `GPUAdapter.prototype`, when this host has WebGPU.
 *
 * @returns The prototype, or `null` on a host without WebGPU.
 */
function globalAdapterPrototype(): PatchableAdapterPrototype | null {
  if (typeof navigator === 'undefined') return null;
  // `navigator.gpu` is `undefined` on hosts without WebGPU, whatever the types say.
  if ((navigator.gpu as GPU | undefined) === undefined) return null;
  if (typeof GPUAdapter === 'undefined') return null;
  return GPUAdapter.prototype;
}

/**
 * Patch `GPUAdapter.prototype.requestDevice` so every device the page creates
 * clears the engine's limits.
 *
 * Idempotent. Calling it again does not wrap the method twice; it raises the
 * requested limits if the new call asks for more. Safe to call on a host with
 * no WebGPU at all, where it does nothing and returns `false`.
 *
 * Must run **before** `renderer.init()`, and before anything else creates a
 * device.
 *
 * @param options Limits to request, and the prototype to patch.
 * @returns True when the patch is installed, false when the host has no WebGPU.
 *
 * @example
 * ```ts
 * import { initWebGPUPatches } from 'gameable/core';
 * import { WebGPURenderer } from 'three/webgpu';
 *
 * initWebGPUPatches({ maxStorageBuffersPerShaderStage: 10 });
 * const renderer = new WebGPURenderer({ canvas: document.createElement('canvas') });
 * await renderer.init();
 * ```
 */
export function initWebGPUPatches(options: WebGPUPatchOptions = {}): boolean {
  const proto = options.target ?? globalAdapterPrototype();
  if (proto === null) return false;

  const wanted =
    options.maxStorageBuffersPerShaderStage ?? DEFAULT_MAX_STORAGE_BUFFERS_PER_SHADER_STAGE;
  const wantsTimestamps = options.timestampQuery ?? false;

  const holder = proto as PatchableAdapterPrototype & { [PATCH_STATE]?: PatchState };
  const existing = holder[PATCH_STATE];
  if (existing !== undefined) {
    existing.maxStorageBuffersPerShaderStage = Math.max(
      existing.maxStorageBuffersPerShaderStage,
      wanted,
    );
    existing.timestampQuery ||= wantsTimestamps;
    return true;
  }

  // Deliberately unbound: the patch re-invokes it with `.call(this)` so each
  // adapter keeps its own `this`. That is what a prototype patch is.
  // eslint-disable-next-line @typescript-eslint/unbound-method
  const original = proto.requestDevice;
  if (typeof original !== 'function') return false;

  const state: PatchState = {
    maxStorageBuffersPerShaderStage: wanted,
    timestampQuery: wantsTimestamps,
  };

  proto.requestDevice = function patchedRequestDevice(
    this: GPUAdapter,
    descriptor?: GPUDeviceDescriptor,
  ): Promise<GPUDevice> {
    const adapterMax =
      (this.limits as GPUSupportedLimits | undefined)?.maxStorageBuffersPerShaderStage ??
      WEBGPU_DEFAULT_STORAGE_BUFFERS;
    const want = Math.min(state.maxStorageBuffersPerShaderStage, adapterMax);

    // Copy the caller's limits rather than replacing them, and remember what
    // they asked for so the patch can only ever raise it.
    const requiredLimits: Record<string, GPUSize64> = {};
    let alreadyRequested = 0;
    const incoming = descriptor?.requiredLimits;
    if (incoming !== undefined) {
      for (const [key, value] of Object.entries(incoming)) {
        if (value === undefined) continue;
        requiredLimits[key] = value;
        if (key === 'maxStorageBuffersPerShaderStage') alreadyRequested = value;
      }
    }
    requiredLimits.maxStorageBuffersPerShaderStage = Math.max(alreadyRequested, want);

    let requiredFeatures = descriptor?.requiredFeatures;
    if (state.timestampQuery && this.features.has('timestamp-query')) {
      const already =
        requiredFeatures !== undefined && [...requiredFeatures].includes('timestamp-query');
      if (!already) requiredFeatures = [...(requiredFeatures ?? []), 'timestamp-query'];
    }

    return original.call(this, { ...descriptor, requiredLimits, requiredFeatures });
  };

  Object.defineProperty(proto, PATCH_STATE, {
    value: state,
    configurable: true,
    enumerable: false,
    writable: true,
  });

  return true;
}

/**
 * Whether a prototype already carries the patch.
 *
 * @param target Prototype to check. Defaults to the global `GPUAdapter.prototype`.
 * @returns True when {@link initWebGPUPatches} has run against it.
 *
 * @example
 * ```ts
 * import { initWebGPUPatches, isWebGPUPatched } from 'gameable/core';
 *
 * initWebGPUPatches();
 * console.log(isWebGPUPatched()); // true in a browser with WebGPU
 * ```
 */
export function isWebGPUPatched(target?: PatchableAdapterPrototype): boolean {
  const proto = target ?? globalAdapterPrototype();
  if (proto === null) return false;
  return (proto as { [PATCH_STATE]?: PatchState })[PATCH_STATE] !== undefined;
}
