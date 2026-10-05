// The renderer's device handed to onnxruntime-web (see index.ts for the order that matters).
// Apart from index.ts so that `prepareLiftDevice` does not import onnxruntime-web: an app that
// never decodes (an exported character, `gameable/character/aosrig`) bundles none of it.

import * as ort from '../ort.js';

/** What `attachOrtDevice` managed to do. */
export interface OrtDeviceAttachment {
  /** True when ORT accepted the renderer's device. */
  readonly shared: boolean;
  /** Why not, when `shared` is false. Null on success. */
  readonly reason: string | null;
  /**
   * When false, every decoder session must be built with `downloadOutputs` so its
   * outputs come back as CPU arrays. A cross-device `GPUBuffer` is a validation
   * error, not a slow path.
   */
  readonly gpuBufferIo: boolean;
}

/**
 * Hand the renderer's `GPUDevice` to onnxruntime-web.
 *
 * The property is `ort.env.webgpu.device`, and in onnxruntime-web 1.29 it is a
 * genuine accessor pair: the SETTER takes a `GPUDevice` and the GETTER returns a
 * `Promise<GPUDevice>` (it will create one on demand if nothing was set). Setting
 * it only has effect BEFORE the first WebGPU inference session is created — which
 * is why this must run immediately after `prepareLiftDevice` and before any
 * decoder is built.
 *
 * `env.webgpu.adapter` also exists and is settable, but it is deprecated in 1.29
 * and it is the wrong lever anyway: an adapter would let ORT build its own device
 * off the same hardware, which is still a DIFFERENT device and still refuses a
 * cross-device buffer. If a future ORT drops the device setter, the fallback is
 * the one below — `gpuBufferIo: false`, every decoder output downloaded to a CPU
 * `Float32Array` and re-uploaded by the lift. That costs one round trip per
 * decode and is correct; it is the POC's own demote path
 * (`DecoderSession.setDownloadOutputs`).
 *
 * Never throws: a character that cannot share the device still renders, slower.
 *
 * @param device The renderer's device, from {@link prepareLiftDevice}.
 * @returns Whether ORT took the device, why it did not, and whether decoder
 * outputs may therefore stay in `GPUBuffer`s instead of being downloaded.
 */
export function attachOrtDevice(device: GPUDevice): OrtDeviceAttachment {
  const webgpu = (ort as { env?: { webgpu?: { device?: unknown } } }).env?.webgpu;
  if (!webgpu) {
    return {
      shared: false,
      reason: 'onnxruntime-web exposes no env.webgpu — decoder outputs will be downloaded',
      gpuBufferIo: false,
    };
  }
  try {
    (webgpu as { device: GPUDevice }).device = device;
  } catch (cause) {
    return {
      shared: false,
      reason: `ort.env.webgpu.device refused the renderer's device (${String(cause)}) — decoder outputs will be downloaded`,
      gpuBufferIo: false,
    };
  }
  return { shared: true, reason: null, gpuBufferIo: true };
}

/**
 * Confirm ORT is really on `device` once the first session exists.
 *
 * The getter resolves to whatever ORT actually built, so this is the only honest
 * check — a successful `set` is an intention, not an outcome. A mismatch DEMOTES
 * loudly rather than handing the lift a foreign buffer.
 *
 * @param device The device ORT was asked to adopt, from {@link prepareLiftDevice}.
 * @returns True when ORT's device is that same object; false — with a warning — when
 * ORT built its own or exposes no `env.webgpu`, meaning outputs must be downloaded.
 */
export async function verifyOrtDevice(device: GPUDevice): Promise<boolean> {
  const webgpu = (ort as { env?: { webgpu?: { device?: unknown } } }).env?.webgpu;
  if (!webgpu) return false;
  try {
    const actual = (await (webgpu as { device: Promise<GPUDevice> }).device) as unknown;
    if (actual === device) return true;
    console.warn(
      '[character] ORT built its own WebGPU device — decoder outputs will be downloaded to the CPU. ' +
        'Call attachOrtDevice() before the first inference session.',
    );
    return false;
  } catch (cause) {
    console.warn('[character] could not read ort.env.webgpu.device', cause);
    return false;
  }
}
