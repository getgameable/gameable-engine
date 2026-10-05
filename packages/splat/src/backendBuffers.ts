/**
 * The **only** file in the repository allowed to reach into three.js's renderer backend.
 *
 * `AGENTS.md` hard rule 8. Everything here is private surface in `three@0.186.0`; if a
 * three upgrade moves it, exactly one file fails and every probe below names the version it
 * was written against.
 *
 * ## What is being reached for, and why
 *
 * `GaussianSplat` repacks its source geometry **once**, in `createStorageBuffers`
 * (`GaussianSplat.js:629-690`), into four `StorageBufferAttribute`s held on the private
 * `_buffers` field. Those four buffers are what the vertex stage reads; the source
 * `BufferGeometry` attributes are afterwards used only by `raycast`, the bounds helpers and
 * the WebGL CPU sort. A producer that wants to write gaussians from a compute shader with no
 * CPU round trip therefore has to write *those* buffers, and nothing in the public API hands
 * them out.
 *
 * ## The layout, which a producer must match exactly
 *
 * | Buffer | WGSL type | Contents |
 * | --- | --- | --- |
 * | `center` | `array<vec4<f32>>` | `xyz` = centre in local space, `w` unused (upstream leaves it 0) |
 * | `covarianceA` | `array<vec4<f32>>` | `(c00, c01, c02, c11)` |
 * | `covarianceB` | `array<vec4<f32>>` | `(c12, c22, 0, 0)` |
 * | `color` | `array<u32>` | `r | g<<8 | b<<16 | a<<24`, i.e. `pack4x8unorm(vec4(r,g,b,a))` |
 *
 * The six covariance floats are the upper triangle of the symmetric 3x3 covariance in
 * `GaussianSplatUtils.writeCovariance` order — `c00, c01, c02, c11, c12, c22` — split 4/2
 * across the two `vec4` buffers. `covarianceB.zw` is padding and is never read. A colour word
 * of `0` is alpha 0, so zero-filled storage renders as nothing, which is what makes an
 * unallocated slot invisible for free.
 *
 * Every buffer is `capacity` elements long: 16 bytes per splat for each of the three `vec4`
 * buffers and 4 bytes for the colour word, 52 bytes per gaussian in total.
 *
 * ## Usage flags
 *
 * No flag plumbing is needed. `WebGPUBackend.createStorageAttribute` allocates
 * `STORAGE | VERTEX | COPY_SRC | COPY_DST`, which already covers compute writes, the
 * vertex-stage storage reads and readback. `acquireSplatGPUBuffers` asserts it.
 *
 * @example
 * ```ts
 * import { acquireSplatGPUBuffers, getGPUDevice } from 'gameable/splat';
 *
 * const device = getGPUDevice(renderer);
 * const buffers = acquireSplatGPUBuffers(renderer, splat.object3D);
 * const bindGroup = device.createBindGroup({
 *   layout: pipeline.getBindGroupLayout(0),
 *   entries: [
 *     { binding: 0, resource: { buffer: buffers.center } },
 *     { binding: 1, resource: { buffer: buffers.covarianceA } },
 *     { binding: 2, resource: { buffer: buffers.covarianceB } },
 *     { binding: 3, resource: { buffer: buffers.color } },
 *   ],
 * });
 * ```
 */
import type { WebGPURenderer } from 'three/webgpu';

/** The three version this file's private-surface knowledge was written against. */
export const SUPPORTED_THREE_VERSION = '0.186.0';

/** Bytes one gaussian occupies across the four storage buffers. */
export const BYTES_PER_GAUSSIAN = 16 + 16 + 16 + 4;

/** The four storage buffers behind a `GaussianSplat`, as real `GPUBuffer`s. */
export interface SplatGPUBuffers {
  /** `array<vec4<f32>>`: `xyz` = centre in local space, `w` unused. */
  readonly center: GPUBuffer;
  /** `array<vec4<f32>>`: `(c00, c01, c02, c11)`. */
  readonly covarianceA: GPUBuffer;
  /** `array<vec4<f32>>`: `(c12, c22, 0, 0)`. */
  readonly covarianceB: GPUBuffer;
  /** `array<u32>`: `pack4x8unorm(vec4(r, g, b, a))`. */
  readonly color: GPUBuffer;
}

/** Reaching into three, spelled out so the rest of the file stays type-safe. */
interface StorageNodeLike {
  /** The `StorageBufferAttribute` the node wraps (`InputNode.value`). */
  readonly value?: unknown;
}

/** The private `_buffers` record built by `createStorageBuffers`. */
interface SplatBuffersLike {
  readonly count?: number;
  readonly centerRead?: StorageNodeLike;
  readonly covarianceARead?: StorageNodeLike;
  readonly covarianceBRead?: StorageNodeLike;
  readonly colorRead?: StorageNodeLike;
}

/**
 * What `backend.get(attribute)` holds for a storage attribute.
 *
 * WebGPU: `{ buffer }`. WebGL: a `DualAttributeData` (`WebGLAttributeUtils.js:13`), two GL
 * buffers of which `bufferGPU` is the one the last transform-feedback pass wrote (the
 * backend swaps them after every compute) and `buffers` is both.
 */
interface AttributeDataLike {
  readonly buffer?: GPUBuffer;
  readonly bufferGPU?: WebGLBuffer;
  readonly buffers?: readonly WebGLBuffer[];
  readonly byteLength?: number;
}

/** The slice of `WebGPUBackend` / `WebGLBackend` this file uses. */
interface BackendLike {
  readonly isWebGLBackend?: boolean;
  readonly device?: GPUDevice;
  readonly gl?: WebGL2RenderingContext;
  createStorageAttribute?: (attribute: unknown) => void;
  destroyAttribute?: (attribute: unknown) => void;
  get?: (attribute: unknown) => AttributeDataLike | undefined;
  has?: (attribute: unknown) => boolean;
}

/** `Renderer.backend`, which is documented but not typed in `@types/three`. */
interface RendererLike {
  readonly backend?: BackendLike;
}

/** Anything carrying the private `_buffers` field: the upstream class or the fork. */
interface SplatLike {
  readonly _buffers?: SplatBuffersLike;
}

/** The four keys, in the order they are probed and reported. */
const KEYS = ['center', 'covarianceA', 'covarianceB', 'color'] as const;

/** Which `_buffers` field backs each key. */
const NODE_FIELDS = {
  center: 'centerRead',
  covarianceA: 'covarianceARead',
  covarianceB: 'covarianceBRead',
  color: 'colorRead',
} as const satisfies Record<(typeof KEYS)[number], keyof SplatBuffersLike>;

/**
 * What the backend holds for an attribute, without creating an entry.
 *
 * `Backend.get` is get-or-create (`DataMap.get`): asking about an attribute the backend has
 * not materialised yet leaves an empty record behind, after which `createStorageAttribute`
 * sees `has(attribute)` and never allocates the buffer. On WebGL that surfaced as
 * "beginTransformFeedback: not enough transform feedback buffers bound".
 *
 * @param backend The renderer's backend.
 * @param attribute A buffer attribute.
 * @returns The backend's record, or undefined when there is none yet.
 */
function peek(backend: BackendLike, attribute: object): AttributeDataLike | undefined {
  if (typeof backend.has === 'function' && !backend.has(attribute)) return undefined;
  return backend.get?.(attribute);
}

/**
 * Fail with a message that says which three version this code knows about.
 *
 * @param what What was expected and not found.
 * @returns Never; always throws.
 */
function moved(what: string): never {
  throw new Error(
    `@gameable/splat: ${what}. This is private three.js surface and the code in ` +
      `packages/splat/src/backendBuffers.ts was written against three@${SUPPORTED_THREE_VERSION}. ` +
      'Re-check GaussianSplat.js / WebGPUBackend.js against the installed version, then update ' +
      'this file and src/three-fork/UPSTREAM.md together.',
  );
}

/**
 * The one `GPUDevice` in the process — the renderer's.
 *
 * `AGENTS.md` hard rule 7: nothing calls `navigator.gpu.requestAdapter()`. The device only
 * exists after `await renderer.init()`, and the backend object is *replaced* when the
 * renderer falls back to WebGL, so never cache either across `init`.
 *
 * @param renderer An initialised `WebGPURenderer`.
 * @returns The device the renderer owns.
 * @throws {Error} When the renderer is not initialised, or fell back to WebGL.
 *
 * @example
 * ```ts
 * await renderer.init();
 * const device = getGPUDevice(renderer);
 * device.createShaderModule({ code });
 * ```
 */
export function getGPUDevice(renderer: WebGPURenderer): GPUDevice {
  const backend = (renderer as unknown as RendererLike).backend;
  if (backend === undefined) {
    moved('renderer.backend is missing; call `await renderer.init()` first');
  }
  if (backend.isWebGLBackend === true) {
    throw new Error(
      '@gameable/splat: the renderer fell back to the WebGL backend, which has no GPUDevice. ' +
        'Check `engine.caps.webgpu` before asking for one.',
    );
  }
  const device = backend.device;
  if (device === undefined) {
    throw new Error(
      '@gameable/splat: renderer.backend.device is not set yet; `await renderer.init()` must ' +
        'complete before any GPU resource is created.',
    );
  }
  return device;
}

/**
 * Whether this renderer got a real WebGPU backend rather than the WebGL fallback.
 *
 * @param renderer A renderer, initialised or not.
 * @returns True for the WebGPU backend.
 *
 * @example
 * ```ts
 * await renderer.init();
 * if (!isWebGPUBackend(renderer)) console.warn('static splats only');
 * ```
 */
export function isWebGPUBackend(renderer: WebGPURenderer): boolean {
  const backend = (renderer as unknown as RendererLike).backend;
  return backend !== undefined && backend.isWebGLBackend !== true;
}

/**
 * Which backend an initialised renderer ended up on.
 *
 * Unlike {@link isWebGPUBackend}, this refuses to answer for a renderer that has not been
 * initialised, because before `init` there is no backend to ask and "not WebGPU" would be a
 * guess.
 *
 * @param renderer An initialised `WebGPURenderer`.
 * @returns `'webgpu'`, or `'webgl'` for the WebGL2 fallback.
 * @throws {Error} When the renderer has not been initialised.
 *
 * @example
 * ```ts
 * await renderer.init();
 * if (backendKind(renderer) === 'webgl') console.info('WebGL2 fallback: CPU sort from readback');
 * ```
 */
export function backendKind(renderer: WebGPURenderer): 'webgpu' | 'webgl' {
  const backend = (renderer as unknown as RendererLike).backend;
  if (backend === undefined) {
    moved('renderer.backend is missing; call `await renderer.init()` first');
  }
  if (backend.isWebGLBackend === true) return 'webgl';
  if (backend.device === undefined) {
    throw new Error(
      '@gameable/splat: renderer.backend.device is not set yet; `await renderer.init()` must ' +
        'complete before any GPU resource is created.',
    );
  }
  return 'webgpu';
}

/** A splat's four gaussian storage attributes, keyed like {@link SplatGPUBuffers}. */
export interface SplatStorageAttributes {
  /** `vec4` per gaussian: `xyz` = centre in local space. */
  readonly center: object;
  /** `vec4` per gaussian: `(c00, c01, c02, c11)`. */
  readonly covarianceA: object;
  /** `vec4` per gaussian: `(c12, c22, 0, 0)`. */
  readonly covarianceB: object;
  /** `uint` per gaussian: `pack4x8unorm(vec4(r, g, b, a))`. */
  readonly color: object;
}

/**
 * The four `StorageBufferAttribute`s behind a splat, from its private `_buffers` field.
 *
 * Backend-neutral: a TSL compute node built over these writes the splat on WebGPU and on the
 * WebGL fallback alike. In dynamic mode they are `StorageInstancedBufferAttribute`s (fork edit
 * 17), which is what makes the fallback's transform feedback index them per invocation.
 *
 * @param splat A `GaussianSplat` or `AnimatedGaussianSplat`.
 * @returns The four attributes.
 * @throws {Error} When three's internals moved.
 *
 * @example
 * ```ts
 * import { storage } from 'three/tsl';
 *
 * const { center } = splatStorageAttributes(splat);
 * const centerWrite = storage(center, 'vec4', capacity);
 * ```
 */
export function splatStorageAttributes(splat: object): SplatStorageAttributes {
  const buffers = (splat as SplatLike)._buffers;
  if (buffers === undefined) {
    moved('the splat has no `_buffers` field (GaussianSplat.js:170)');
  }
  const out: Record<string, object> = {};
  for (const key of KEYS) {
    const field = NODE_FIELDS[key];
    const node = buffers[field];
    if (node === undefined) {
      moved(`the splat's _buffers.${field} is missing (GaussianSplat.js:671-674)`);
    }
    const attribute = node.value;
    if (attribute === undefined || attribute === null || typeof attribute !== 'object') {
      moved(`the splat's _buffers.${field}.value is not a StorageBufferAttribute`);
    }
    out[key] = attribute;
  }
  return out as unknown as SplatStorageAttributes;
}

/**
 * Materialise a splat's four storage attributes as real `GPUBuffer`s and hand them back.
 *
 * Idempotent in both directions: `createStorageAttribute` early-returns when the buffer
 * already exists, and the same `GPUBuffer` objects come back on every call for the lifetime
 * of the splat. The buffers are owned by three — do not destroy them; dispose the splat.
 *
 * @param renderer An initialised `WebGPURenderer`.
 * @param splat A `GaussianSplat` or `AnimatedGaussianSplat`.
 * @returns The four buffers, in the layout documented at the top of this file.
 * @throws {Error} When the backend is WebGL, the renderer is not initialised, or three's
 *   internals moved.
 *
 * @example
 * ```ts
 * const buffers = acquireSplatGPUBuffers(renderer, splat);
 * console.log(buffers.center.size / 16); // gaussian capacity
 * ```
 */
export function acquireSplatGPUBuffers(renderer: WebGPURenderer, splat: object): SplatGPUBuffers {
  // Throws for WebGL and for an uninitialised renderer, with the right message for each.
  getGPUDevice(renderer);

  const backend = (renderer as unknown as RendererLike).backend;
  if (backend === undefined) moved('renderer.backend is missing');
  if (typeof backend.createStorageAttribute !== 'function') {
    moved('renderer.backend.createStorageAttribute is not a function (WebGPUBackend.js)');
  }
  if (typeof backend.get !== 'function') {
    moved('renderer.backend.get is not a function (Backend.js)');
  }

  const attributes = splatStorageAttributes(splat);
  const out: Record<string, GPUBuffer> = {};

  for (const key of KEYS) {
    const field = NODE_FIELDS[key];
    const attribute = attributes[key];

    // Idempotent: WebGPUAttributeUtils early-returns when the GPUBuffer already exists.
    backend.createStorageAttribute(attribute);

    const gpuBuffer = backend.get(attribute)?.buffer;
    if (gpuBuffer === undefined) {
      moved(`renderer.backend.get(_buffers.${field}.value).buffer is undefined (Backend.js)`);
    }

    const needed = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST;
    if ((gpuBuffer.usage & needed) !== needed) {
      moved(
        `the ${key} buffer was allocated with usage 0x${gpuBuffer.usage.toString(16)}, which is ` +
          'missing STORAGE and/or COPY_DST',
      );
    }

    out[key] = gpuBuffer;
  }

  return out as unknown as SplatGPUBuffers;
}

/**
 * Materialise one `StorageBufferAttribute` as a real `GPUBuffer` and hand it back.
 *
 * For a producer that writes a buffer from its own compute pass which a three material then
 * reads through `storage(attribute, …)` — a character's mouth writes its mesh this way. The
 * same private surface as {@link acquireSplatGPUBuffers}, for any storage attribute. The
 * buffer is owned by three; give it back with {@link releaseStorageAttribute}.
 *
 * @param renderer An initialised `WebGPURenderer`.
 * @param attribute A `StorageBufferAttribute`.
 * @returns Its `GPUBuffer`, with `STORAGE | COPY_DST` usage.
 * @throws {Error} When the backend is WebGL, the renderer is not initialised, or three's
 *   internals moved.
 *
 * @example
 * ```ts
 * const attribute = new StorageBufferAttribute(new Float32Array(1024 * 4), 4);
 * const buffer = acquireStorageGPUBuffer(renderer, attribute);
 * device.queue.writeBuffer(buffer, 0, new Float32Array(1024 * 4));
 * ```
 */
export function acquireStorageGPUBuffer(renderer: WebGPURenderer, attribute: object): GPUBuffer {
  getGPUDevice(renderer);
  const backend = (renderer as unknown as RendererLike).backend;
  if (backend === undefined) moved('renderer.backend is missing');
  if (typeof backend.createStorageAttribute !== 'function') {
    moved('renderer.backend.createStorageAttribute is not a function (WebGPUBackend.js)');
  }
  if (typeof backend.get !== 'function') {
    moved('renderer.backend.get is not a function (Backend.js)');
  }
  backend.createStorageAttribute(attribute);
  const gpuBuffer = backend.get(attribute)?.buffer;
  if (gpuBuffer === undefined)
    moved('renderer.backend.get(attribute).buffer is undefined (Backend.js)');
  const needed = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST;
  if ((gpuBuffer.usage & needed) !== needed) {
    moved(
      `a storage attribute was allocated with usage 0x${gpuBuffer.usage.toString(16)}, which is ` +
        'missing STORAGE and/or COPY_DST',
    );
  }
  return gpuBuffer;
}

/**
 * Destroy the `GPUBuffer` behind one storage attribute.
 *
 * The counterpart to {@link acquireSplatGPUBuffers}, and the reason this file exists: three
 * creates a storage attribute's buffer through `backend.createStorageAttribute` and destroys it
 * through `backend.destroyAttribute`, and neither is reachable from the public API.
 * `BufferAttribute.dispose()` only dispatches a `dispose` event, which `Geometries.js` listens
 * for on vertex and index attributes but never on storage ones — so without this call every
 * disposed dynamic splat leaks its buffers for the lifetime of the page.
 *
 * Safe to call more than once and on an attribute that was never uploaded: it returns false
 * rather than letting `destroyAttribute` dereference a missing buffer.
 *
 * @param renderer The renderer that materialised the attribute.
 * @param attribute A `StorageBufferAttribute` (or any `BufferAttribute`).
 * @returns True when a GPU buffer was destroyed.
 *
 * @example
 * ```ts
 * for (const attribute of splat.storageAttributes()) releaseStorageAttribute(renderer, attribute);
 * ```
 */
export function releaseStorageAttribute(renderer: WebGPURenderer, attribute: object): boolean {
  const backend = (renderer as unknown as RendererLike).backend;
  if (backend === undefined) return false;
  if (typeof backend.get !== 'function' || typeof backend.destroyAttribute !== 'function') {
    return false;
  }
  const data = peek(backend, attribute);

  if (backend.isWebGLBackend === true) {
    // `WebGLAttributeUtils.destroyAttribute` deletes only `bufferGPU`, the active one of a
    // storage attribute's two transform-feedback buffers, and never the PBO texture the draw
    // reads through. Delete the other buffer here, and dispose the texture (three's
    // `Textures` does listen for a texture's `dispose` event).
    if (data?.bufferGPU === undefined) return false;
    const gl = backend.gl;
    if (gl !== undefined && data.buffers !== undefined) {
      for (const buffer of data.buffers) {
        if (buffer !== data.bufferGPU) gl.deleteBuffer(buffer);
      }
    }
    backend.destroyAttribute(attribute);
    (attribute as { pbo?: { dispose?: () => void } }).pbo?.dispose?.();
    return true;
  }

  // `WebGPUAttributeUtils.destroyAttribute` calls `data.buffer.destroy()` unguarded, so an
  // attribute the backend never saw — a splat disposed before its first frame — would throw.
  if (data?.buffer === undefined) return false;

  backend.destroyAttribute(attribute);
  return true;
}

/** How many bytes of zeros {@link clearStorageAttributeRange} uploads per call on WebGL. */
const GL_CLEAR_CHUNK_BYTES = 1 << 20;

/**
 * Zero a byte range of a storage attribute on the WebGL fallback.
 *
 * Zeroes the CPU array (what three uploads if the GL buffers do not exist yet) and, when they
 * do, both transform-feedback buffers. The PBO texture the draw reads is refreshed by the next
 * compute pass over the attribute, which on the fallback covers the whole capacity every frame.
 * Not a per-frame operation: it allocates one chunk of zeros.
 *
 * @param renderer An initialised renderer on the WebGL fallback.
 * @param attribute A storage attribute of the splat.
 * @param byteOffset First byte to clear.
 * @param byteLength Bytes to clear.
 * @returns Nothing.
 * @throws {Error} When the renderer is on WebGPU (use `queue.writeBuffer` there).
 *
 * @example
 * ```ts
 * const { color } = splatStorageAttributes(splat);
 * clearStorageAttributeRange(renderer, color, 0, capacity * 4); // every gaussian invisible
 * ```
 */
export function clearStorageAttributeRange(
  renderer: WebGPURenderer,
  attribute: object,
  byteOffset: number,
  byteLength: number,
): void {
  const backend = (renderer as unknown as RendererLike).backend;
  if (backend?.isWebGLBackend !== true) {
    throw new Error('@gameable/splat: clearStorageAttributeRange is for the WebGL fallback');
  }
  const array = (attribute as { array?: ArrayBufferView }).array;
  if (array !== undefined) {
    new Uint8Array(array.buffer, array.byteOffset + byteOffset, byteLength).fill(0);
  }

  const data = peek(backend, attribute);
  const gl = backend.gl;
  if (gl === undefined || data === undefined) return;
  const buffers = data.buffers ?? (data.bufferGPU === undefined ? [] : [data.bufferGPU]);
  const zeros = new Uint8Array(Math.min(byteLength, GL_CLEAR_CHUNK_BYTES));
  for (const buffer of buffers) {
    gl.bindBuffer(gl.COPY_WRITE_BUFFER, buffer);
    for (let done = 0; done < byteLength; done += zeros.byteLength) {
      const n = Math.min(zeros.byteLength, byteLength - done);
      gl.bufferSubData(gl.COPY_WRITE_BUFFER, byteOffset + done, zeros, 0, n);
    }
  }
  gl.bindBuffer(gl.COPY_WRITE_BUFFER, null);
}

/**
 * A non-blocking readback of one storage attribute on the WebGL fallback.
 *
 * `start` copies the buffer the last compute pass wrote into a private staging buffer and
 * drops a fence; `poll` checks the fence without waiting and, once the GPU has passed it,
 * copies the staging buffer into `data`. One copy is in flight at a time, and nothing is
 * allocated after the first `start`.
 */
export interface StorageReadback {
  /** The attribute's contents as of the last `start` whose `poll` returned true. */
  readonly data: Float32Array;
  /** True between a successful `start` and the `poll` that lands it. */
  readonly pending: boolean;
  /**
   * Copy the attribute's current contents towards `data`.
   *
   * @returns False, doing nothing, when a copy is already in flight or the attribute has no
   *   GL buffer yet (nothing has drawn or computed with it).
   */
  start(): boolean;
  /**
   * Land the copy in flight if the GPU is done with it. Never waits.
   *
   * @returns True exactly once per `start`, when `data` has just been refreshed.
   */
  poll(): boolean;
  /**
   * Delete the staging buffer and any fence. Idempotent.
   *
   * @returns Nothing.
   */
  dispose(): void;
}

/**
 * Build a fenced readback for a float storage attribute on the WebGL fallback.
 *
 * Three's own `renderer.getArrayBufferAsync` is not asynchronous on WebGL in r186:
 * `WebGLAttributeUtils.getArrayBufferAsync` calls `getBufferSubData` straight away, which makes
 * the CPU wait for the GPU. On an RTX 4080 that blocked the main thread 3.5–4.6 ms per frame at
 * 262k gaussians, and it pinned SwiftShader at 17 ms a frame. This one copies GPU-side, fences,
 * and reads only after the fence has signalled, so the data arrives a frame or more later
 * instead of stalling this one.
 *
 * Poll it once a frame (from `onBeforeRender`, say); `poll` has no timer of its own.
 *
 * @param renderer An initialised renderer on the WebGL fallback.
 * @param attribute A storage attribute whose array is a `Float32Array`.
 * @returns The readback.
 * @throws {Error} When the renderer is on WebGPU, or the attribute's array is not float.
 *
 * @example
 * ```ts
 * const readback = createStorageReadback(renderer, splatStorageAttributes(splat).center);
 * // once per frame, after the compute pass that wrote the centres:
 * if (readback.poll()) useCenters(readback.data);
 * if (!readback.pending) readback.start();
 * ```
 */
export function createStorageReadback(
  renderer: WebGPURenderer,
  attribute: object,
): StorageReadback {
  const backend = (renderer as unknown as RendererLike).backend;
  if (backend?.isWebGLBackend !== true || backend.gl === undefined) {
    throw new Error(
      '@gameable/splat: createStorageReadback is for the WebGL fallback; on WebGPU the sort ' +
        'runs on the GPU and needs no readback',
    );
  }
  if (typeof backend.get !== 'function') {
    moved('renderer.backend.get is not a function (Backend.js)');
  }
  const array = (attribute as { array?: unknown }).array;
  if (!(array instanceof Float32Array)) {
    throw new Error('@gameable/splat: createStorageReadback needs a Float32Array attribute');
  }

  const gl = backend.gl;
  const owner = backend;
  const data = new Float32Array(array.length);
  let staging: WebGLBuffer | null = null;
  let sync: WebGLSync | null = null;
  let disposed = false;

  return {
    data,
    get pending() {
      return sync !== null;
    },
    start() {
      if (disposed || sync !== null) return false;
      const source = peek(owner, attribute)?.bufferGPU;
      if (source === undefined) return false;
      if (staging === null) {
        staging = gl.createBuffer();
        gl.bindBuffer(gl.COPY_WRITE_BUFFER, staging);
        // Not a READ usage: Chrome keeps a "shadow copy" of READ-usage buffers to speed their
        // readback, never used it here (every cycle warned that it was discarded, and each
        // read cost the same ~2 ms at 250k either way), and floods the console until WebGL
        // stops reporting errors. A COPY usage is outside that tracking.
        gl.bufferData(gl.COPY_WRITE_BUFFER, data.byteLength, gl.DYNAMIC_COPY);
      }
      gl.bindBuffer(gl.COPY_READ_BUFFER, source);
      gl.bindBuffer(gl.COPY_WRITE_BUFFER, staging);
      gl.copyBufferSubData(gl.COPY_READ_BUFFER, gl.COPY_WRITE_BUFFER, 0, 0, data.byteLength);
      gl.bindBuffer(gl.COPY_READ_BUFFER, null);
      gl.bindBuffer(gl.COPY_WRITE_BUFFER, null);
      sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
      // Without a flush the fence can sit in the command buffer and never signal.
      gl.flush();
      return sync !== null;
    },
    poll() {
      if (sync === null || staging === null) return false;
      const status = gl.clientWaitSync(sync, 0, 0);
      if (status === gl.TIMEOUT_EXPIRED) return false;
      gl.deleteSync(sync);
      sync = null;
      if (status === gl.WAIT_FAILED) return false;
      gl.bindBuffer(gl.COPY_READ_BUFFER, staging);
      gl.getBufferSubData(gl.COPY_READ_BUFFER, 0, data);
      gl.bindBuffer(gl.COPY_READ_BUFFER, null);
      return true;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      if (sync !== null) gl.deleteSync(sync);
      if (staging !== null) gl.deleteBuffer(staging);
      sync = null;
      staging = null;
    },
  };
}
