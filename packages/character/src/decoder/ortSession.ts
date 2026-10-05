// ONNX Runtime session-creation helpers.
//
// The `ort` module is passed in by the caller rather than imported here, so the tests
// can drive the whole decoder lifecycle with a fake runtime — real ONNX parity is an
// end-to-end concern, not a unit one.
//
// Ported from aos-threejs-poc/src/lib/ortSession.js @ cdd63b10, minus
// `hasWebGpuAdapter` / `resolveProviders`: nothing here may call
// `navigator.gpu.requestAdapter()` (the renderer owns the device), and the provider
// order now follows from whether `attachOrtDevice` succeeded rather than from a URL
// flag.

/** The slice of the ORT module a session create needs. */
export interface OrtLike {
  InferenceSession: {
    create(src: string | Uint8Array, options: Record<string, unknown>): Promise<unknown>;
  };
}

/** Execution providers, in preference order. */
export type Providers = string[];

/**
 * The provider list for a character.
 *
 * WebGPU first whenever the renderer's device was shared with ORT, because that is
 * what lets the decoders' outputs stay on a gpu-buffer through the geom -> appr
 * handoff and straight into the lift. WASM alone otherwise: a WebGPU EP on a device
 * the lift cannot read costs a download per output and buys nothing.
 *
 * @param sharedDevice True when the renderer's `GPUDevice` was successfully handed to
 * ORT, so a WebGPU EP's outputs are readable by the lift.
 * @returns `['webgpu', 'wasm']` on a shared device, otherwise `['wasm']` alone.
 */
export function providersFor(sharedDevice: boolean): Providers {
  return sharedDevice ? ['webgpu', 'wasm'] : ['wasm'];
}

/**
 * Create an `InferenceSession` with `providers`, retrying once on plain WASM if a
 * non-WASM primary fails to compile or initialise. `extra` is spread into the
 * session options (e.g. `preferredOutputLocation`) and is preserved on the retry.
 *
 * @param ort The ORT module to create through, injected so a test can drive the
 * lifecycle with a fake runtime.
 * @param src The model: a URL ORT fetches, or already-resident `.onnx` bytes.
 * @param providers Execution providers in preference order, from {@link providersFor}.
 * @param extra Session options spread over `executionProviders` and
 * `graphOptimizationLevel` — `preferredOutputLocation` and profiler flags.
 * @returns The created `InferenceSession`, typed `unknown` for the caller to narrow.
 */
export async function createSession(
  ort: OrtLike,
  src: string | Uint8Array,
  providers: Providers,
  extra: Record<string, unknown> = {},
): Promise<unknown> {
  try {
    return await ort.InferenceSession.create(src, {
      executionProviders: providers,
      graphOptimizationLevel: 'all',
      ...extra,
    });
  } catch (e) {
    if (providers[0] !== 'wasm') {
      console.warn('[character] decoder session create failed, retrying on wasm:', e);
      return await ort.InferenceSession.create(src, {
        executionProviders: ['wasm'],
        graphOptimizationLevel: 'all',
        ...extra,
      });
    }
    throw e;
  }
}
