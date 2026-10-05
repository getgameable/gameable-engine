/**
 * The dynamic splat: a fixed-capacity buffer of gaussians that a compute shader owns.
 *
 * This is the producer-facing half of the package and the interface `gameable/character`
 * codes against. It wraps the fork in `src/three-fork/`, the slot allocator in `src/slots.ts`
 * and the private-surface access in `src/backendBuffers.ts`, and exposes to a producer the
 * four gaussian buffers — as TSL storage nodes on either backend, and as raw `GPUBuffer`s on
 * WebGPU — and a way to say "I moved things".
 *
 * On the WebGL2 fallback the sort runs on the CPU. This class reads the deformed centres back
 * with a fence (never stalling a frame), and hands them to the fork's CPU sort a frame or a
 * few late; the camera part of the sort is always current.
 */
import { storage } from 'three/tsl';
import { Sphere, Vector3 } from 'three/webgpu';
import type {
  Node,
  Object3D,
  StorageBufferAttribute,
  StorageBufferNode,
  WebGPURenderer,
} from 'three/webgpu';

import {
  acquireSplatGPUBuffers,
  backendKind,
  BYTES_PER_GAUSSIAN,
  clearStorageAttributeRange,
  createStorageReadback,
  getGPUDevice,
  releaseStorageAttribute,
  splatStorageAttributes,
  type SplatGPUBuffers,
  type SplatStorageAttributes,
  type StorageReadback,
} from './backendBuffers.js';
import { createSlotAllocator, type SlotAllocator, type SlotRange } from './slots.js';
import { initCountingSortPatch } from './sortPatch.js';
import { AnimatedGaussianSplat, padStorageCapacity } from './three-fork/AnimatedGaussianSplat.js';

export type { SlotRange } from './slots.js';
export type { SplatGPUBuffers } from './backendBuffers.js';

/** A centre as a plain triple, so producers need no three import. */
export type Vec3Tuple = [number, number, number];

/**
 * The four gaussian buffers as writable TSL storage nodes, `storageCapacity` elements each.
 *
 * Layout as in `backendBuffers.ts`. A compute node that assigns to `element(instanceIndex)` of
 * these writes the splat on WebGPU and on the WebGL fallback alike. On the fallback the compute
 * runs as transform feedback, which has two consequences a producer must respect: invocation
 * `i` writes element `i` (no offsets, no scattered writes), and each dispatch must cover the
 * whole `storageCapacity`, once per frame — a partial dispatch leaves elements from two frames
 * back, because three double-buffers the attribute and swaps after every pass.
 */
export interface SplatStorageNodes {
  /** `vec4`: `xyz` = centre in local space, `w` written 1. */
  readonly center: StorageBufferNode<'vec4'>;
  /** `vec4`: `(c00, c01, c02, c11)`. */
  readonly covarianceA: StorageBufferNode<'vec4'>;
  /** `vec4`: `(c12, c22, 0, 0)`. */
  readonly covarianceB: StorageBufferNode<'vec4'>;
  /** `uint`: `pack4x8unorm(vec4(r, g, b, a))`. */
  readonly color: StorageBufferNode<'uint'>;
}

/**
 * What a producer writes into.
 *
 * Deliberately small and three-free: a lift shader needs slots, buffers and a way to say the
 * gaussians moved, and nothing else.
 */
export interface SplatSink {
  /** Total gaussians this sink can hold. Fixed for its lifetime. */
  readonly capacity: number;

  /**
   * Reserve a contiguous run of slots.
   *
   * @param count How many gaussians.
   * @returns The range, as `{ offset, count }`.
   */
  allocate(count: number): SlotRange;

  /**
   * Give a range back. The slots are **not** cleared; call `clearSlots` first if the caller
   * is not about to overwrite them.
   *
   * @param range A range from `allocate`.
   * @returns Nothing.
   */
  free(range: SlotRange): void;

  /**
   * The four GPU buffers, in the layout documented in `backendBuffers.ts`. WebGPU only: on
   * the WebGL fallback reading this throws; write through {@link SplatSink.nodes} instead.
   */
  readonly buffers: SplatGPUBuffers;

  /** The four buffers as writable TSL storage nodes, on either backend. */
  readonly nodes: SplatStorageNodes;

  /**
   * Elements actually allocated per buffer: `capacity` padded up to the WebGL fallback's PBO
   * texture shape. The slots past `capacity` are never handed out and stay invisible. A
   * compute on the fallback dispatches exactly this many invocations.
   */
  readonly storageCapacity: number;

  /**
   * Tell the splat its gaussians moved, so the next frame re-sorts.
   *
   * Call it once per frame after the compute pass. Without it the sort only runs when the
   * camera turns more than about 1.81 degrees, and a moving avatar seen from a still camera
   * renders in a stale depth order.
   *
   * @returns Nothing.
   */
  markGaussiansChanged(): void;

  /**
   * Declare where the gaussians are, in the object's local space.
   *
   * The sort quantises depth into 4096 bins across this sphere, so a sphere that does not
   * contain the splats costs precision, and frustum culling is off precisely because this
   * value is a promise rather than a measurement.
   *
   * @param center Local-space centre.
   * @param radius Local-space radius.
   * @returns Nothing.
   */
  setBoundingSphere(center: Vec3Tuple, radius: number): void;

  /** The scene object. Add it to a scene, move it, parent it — it is an ordinary `Object3D`. */
  readonly object3D: Object3D;
}

/** Options accepted by {@link createAnimatedSplat}. */
export interface CreateAnimatedSplatOptions {
  /** Gaussians to allocate. Fixed for the object's lifetime. */
  readonly capacity: number;
  /**
   * Where the gaussians will be, in local space. Defaults to a unit sphere at the origin,
   * which is almost certainly wrong; set it as soon as the producer knows.
   */
  readonly boundingSphere?: { readonly center: Vec3Tuple; readonly radius: number };
  /**
   * Sort in `onBeforeRender`. Defaults to `true`, which is what a producer wants: paired with
   * `markGaussiansChanged` it gives exactly one sort per frame.
   */
  readonly autoSort?: boolean;
  /** Draw order. Defaults to {@link SPLAT_RENDER_ORDER}. */
  readonly renderOrder?: number;
  /**
   * What the producer's packed colour bytes mean. `'srgb'` (the default) is what nearly every
   * splat holds, a character trained against photographs among them: drawn only by
   * `gameable/core`'s `attachSrgbPass` (which the engine and `gameable/three`
   * attach), blending on its sRGB values as it was trained; without a pass it draws nothing and
   * warns once. `'linear'` is for a splat trained in linear light: three's convention, drawn in
   * the app's own pass.
   */
  readonly colorSpace?: 'linear' | 'srgb';
  /**
   * The gaussian kernel. `'three'` (the default) is three's: cut at 2 sigma, opacity reduced
   * as the 2D blur grows. `'studio'` is the Gameable studio's, which exported characters were
   * made on: cut at 2.83 sigma with the tail subtracted, and the trained opacity kept. The
   * studio kernel is what makes a character look as it does in the studio: less washed-out
   * thin details (lashes, hair) and no grain from the hard 2-sigma edge.
   */
  readonly kernel?: 'three' | 'studio';
}

/**
 * Splats draw after opaque geometry.
 *
 * The material is `transparent` with `depthWrite: false`, so three already puts it in the
 * transparent pass; the render order pins splats *after* ordinary transparent meshes, because
 * a splat cloud has no single depth to sort by and would otherwise be interleaved by its
 * object centre.
 */
export const SPLAT_RENDER_ORDER = 1000;

/**
 * The WebGL fallback reads the centres back for the CPU sort at most this often. A character
 * that animates marks its gaussians changed every frame, but its depth order changes slowly;
 * a readback (~2 ms of main thread at 300k gaussians) plus a sort (~1.2 ms) every frame is the
 * cost this saves. Camera moves still re-sort at once, from the latest centres.
 */
const FALLBACK_SORT_INTERVAL_MS = 50;

/** How many bytes of zeros `clearSlots` uploads per `writeBuffer` call. */
const CLEAR_CHUNK_BYTES = 1 << 20;

/** A dynamic splat: {@link SplatSink} plus lifecycle. */
export class AnimatedSplat implements SplatSink {
  readonly capacity: number;
  readonly storageCapacity: number;
  readonly nodes: SplatStorageNodes;
  /** The fork instance. Typed as the fork, not as `Object3D`, for `object3D` consumers. */
  readonly splat: AnimatedGaussianSplat;

  /** The WebGPU device, or null on the WebGL fallback. */
  readonly #device: GPUDevice | null;
  readonly #buffers: SplatGPUBuffers | null;
  readonly #attributes: SplatStorageAttributes;
  /** Kept for `dispose`, which has to reach the backend again to free the storage buffers. */
  readonly #renderer: WebGPURenderer;
  readonly #slots: SlotAllocator;
  readonly #center = new Vector3();
  /** WebGL fallback only: the fenced centre readback and the xyz copy the CPU sort reads. */
  readonly #fallback: {
    readback: StorageReadback | null;
    readonly centers: Float32Array;
    changed: boolean;
    /** `performance.now()` at the last readback's start. */
    lastStart: number;
  } | null;
  #disposed = false;

  /**
   * Use {@link createAnimatedSplat}; the GPU buffers must be acquired before the object is
   * usable, and that needs an initialised renderer.
   *
   * @param renderer An initialised `WebGPURenderer`, on WebGPU or the WebGL2 fallback.
   * @param options Capacity, bounds and draw order.
   */
  constructor(renderer: WebGPURenderer, options: CreateAnimatedSplatOptions) {
    const { capacity } = options;
    if (!Number.isInteger(capacity) || capacity <= 0) {
      throw new RangeError(
        `@gameable/splat: capacity must be a positive integer, got ${String(capacity)}`,
      );
    }

    const webgl = backendKind(renderer) === 'webgl';
    this.#device = webgl ? null : getGPUDevice(renderer);
    this.#renderer = renderer;
    this.capacity = capacity;
    this.storageCapacity = padStorageCapacity(capacity);
    this.#slots = createSlotAllocator(capacity);

    const bounds = options.boundingSphere;
    const splat = new AnimatedGaussianSplat(
      {
        capacity,
        boundingSphere:
          bounds === undefined
            ? undefined
            : new Sphere(new Vector3(...bounds.center), bounds.radius),
        colorSpace: options.colorSpace ?? 'srgb',
        kernel: options.kernel,
      },
      { autoSort: options.autoSort ?? true },
    );
    splat.name = 'AnimatedSplat';
    splat.renderOrder = options.renderOrder ?? SPLAT_RENDER_ORDER;

    this.splat = splat;
    this.#attributes = splatStorageAttributes(splat);
    const n = this.storageCapacity;
    const attribute = (a: object): StorageBufferAttribute => a as StorageBufferAttribute;
    this.nodes = {
      center: storage(attribute(this.#attributes.center), 'vec4', n),
      covarianceA: storage(attribute(this.#attributes.covarianceA), 'vec4', n),
      covarianceB: storage(attribute(this.#attributes.covarianceB), 'vec4', n),
      color: storage(attribute(this.#attributes.color), 'uint', n),
    };
    this.#buffers = webgl ? null : acquireSplatGPUBuffers(renderer, splat);

    if (webgl) {
      const fallback = {
        readback: null as StorageReadback | null,
        centers: new Float32Array(n * 3),
        changed: false,
        lastStart: Number.NEGATIVE_INFINITY,
      };
      this.#fallback = fallback;
      // Poll the readback right before the fork sorts. The fork's own `onBeforeRender` does
      // the sort (and the PBO switch the draw needs), so it runs after, unchanged.
      const upstream = splat.onBeforeRender.bind(splat);
      splat.onBeforeRender = (...args: Parameters<typeof upstream>) => {
        this.#syncSortCenters();
        upstream(...args);
      };
    } else {
      this.#fallback = null;
    }
  }

  /**
   * The four GPU buffers. WebGPU only.
   *
   * @returns The buffers, acquired at construction.
   * @throws {Error} On the WebGL fallback, which has no `GPUBuffer`s; use {@link nodes}.
   */
  get buffers(): SplatGPUBuffers {
    if (this.#buffers === null) {
      throw new Error(
        '@gameable/splat: this AnimatedSplat is on the WebGL2 fallback, which has no GPUBuffers. ' +
          'Write the gaussians with a TSL compute node over `sink.nodes` instead.',
      );
    }
    return this.#buffers;
  }

  /**
   * The scene object.
   *
   * @returns The fork instance, which is an ordinary `Object3D`.
   */
  get object3D(): Object3D {
    return this.splat;
  }

  /**
   * Scale each fragment's opacity by a node built from the splat's view-space centre, or
   * pass null to draw as before. See the fork's edit 15.
   *
   * @param builder Returns a float node from the view-space centre (a `vec3` node).
   * @returns Nothing.
   */
  setFragmentAlpha(builder: ((view: Node) => Node) | null): void {
    this.splat.setFragmentAlpha(builder);
  }

  /**
   * Multiply every gaussian's colour, in linear light after the colour-space decode: a tint and
   * an exposure, to fit a character into a scene's light. `(1, 1, 1)` is the file's colour. Set it
   * as often as you like (a uniform).
   *
   * @param r Red multiplier.
   * @param g Green multiplier.
   * @param b Blue multiplier.
   * @returns Nothing.
   */
  setColorScale(r: number, g: number, b: number): void {
    this.splat.setColorScale(r, g, b);
  }

  /**
   * Slots currently handed out.
   *
   * @returns The count.
   */
  get used(): number {
    return this.#slots.used;
  }

  /**
   * Slots not handed out. Named `available`, because `free` is the method above.
   *
   * @returns The count.
   */
  get available(): number {
    return this.#slots.available;
  }

  /**
   * Reserve a contiguous run of slots.
   *
   * @param count How many gaussians.
   * @returns The range.
   */
  allocate(count: number): SlotRange {
    this.#assertLive();
    return this.#slots.allocate(count);
  }

  /**
   * Give a range back.
   *
   * @param range A range from {@link AnimatedSplat.allocate}.
   * @returns Nothing.
   */
  free(range: SlotRange): void {
    this.#assertLive();
    this.#slots.free(range);
  }

  /**
   * Zero a slot range, which makes it invisible: a colour word of 0 is alpha 0.
   *
   * This is a `queue.writeBuffer` of zeros, which is allowed here precisely because it is not
   * a per-frame operation — it runs when a branch is allocated or retired. A producer must
   * never upload gaussian data this way; that is what the compute pass is for.
   *
   * @param range The range to clear. Defaults to the whole capacity.
   * @returns Nothing.
   */
  clearSlots(range?: SlotRange): void {
    this.#assertLive();
    const offset = range?.offset ?? 0;
    const count = range?.count ?? this.capacity;
    if (count <= 0) return;
    if (offset < 0 || offset + count > this.capacity) {
      throw new RangeError(
        `@gameable/splat: clearSlots([${String(offset)}, ${String(offset + count)}) ) is outside ` +
          `capacity ${String(this.capacity)}`,
      );
    }

    if (this.#device === null || this.#buffers === null) {
      const a = this.#attributes;
      for (const [attribute, stride] of [
        [a.center, 16],
        [a.covarianceA, 16],
        [a.covarianceB, 16],
        [a.color, 4],
      ] as const) {
        clearStorageAttributeRange(this.#renderer, attribute, offset * stride, count * stride);
      }
      return;
    }

    const queue = this.#device.queue;
    for (const [buffer, stride] of [
      [this.#buffers.center, 16],
      [this.#buffers.covarianceA, 16],
      [this.#buffers.covarianceB, 16],
      [this.#buffers.color, 4],
    ] as const) {
      const perChunk = Math.max(1, Math.floor(CLEAR_CHUNK_BYTES / stride));
      const zeros = new Uint8Array(Math.min(count, perChunk) * stride);
      for (let done = 0; done < count; done += perChunk) {
        const n = Math.min(perChunk, count - done);
        queue.writeBuffer(buffer, (offset + done) * stride, zeros, 0, n * stride);
      }
    }
  }

  /**
   * Force a re-sort on the next frame.
   *
   * On the WebGL fallback this asks for a readback of the centres instead (at most one every
   * 50 ms); the sort runs when it lands. Calls while one is in flight coalesce into the next.
   *
   * @returns Nothing.
   */
  markGaussiansChanged(): void {
    this.#assertLive();
    if (this.#fallback !== null) {
      this.#fallback.changed = true;
      return;
    }
    this.splat.markGaussiansChanged();
  }

  /**
   * Declare where the gaussians are, in local space.
   *
   * @param center Local-space centre.
   * @param radius Local-space radius.
   * @returns Nothing.
   */
  setBoundingSphere(center: Vec3Tuple, radius: number): void {
    this.#assertLive();
    this.#center.set(center[0], center[1], center[2]);
    this.splat.setBoundingSphere(this.#center, radius);
  }

  /**
   * Detach from the scene and release the geometry, material and every storage buffer.
   *
   * "Every storage buffer" is nine of them: the four gaussian buffers, the spherical-harmonics
   * contribution buffer if the pre-pass ever ran, and the four the sort holds. Three frees none
   * of them on its own — `BufferAttribute.dispose()` dispatches an event nothing listens for on
   * a storage attribute — so a despawned character used to leak about 2 MB of GPU memory.
   *
   * Idempotent, and every mutating method throws afterwards.
   *
   * @returns Nothing.
   */
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.splat.removeFromParent();
    this.#fallback?.readback?.dispose();
    this.splat.dispose((attribute) => {
      releaseStorageAttribute(this.#renderer, attribute);
    });
    this.#slots.reset();
  }

  /**
   * WebGL fallback: land a finished centre readback into the CPU sort, and start the next one
   * when the gaussians changed. Runs from `onBeforeRender`, i.e. after this frame's compute.
   * Allocation-free after the first readback.
   *
   * @returns Nothing.
   */
  #syncSortCenters(): void {
    const fallback = this.#fallback;
    if (fallback === null || this.#disposed) return;
    fallback.readback ??= createStorageReadback(this.#renderer, this.#attributes.center);
    const { readback, centers } = fallback;

    if (readback.poll()) {
      const vec4 = readback.data;
      const count = centers.length / 3;
      for (let i = 0; i < count; i++) {
        centers[i * 3] = vec4[i * 4] ?? 0;
        centers[i * 3 + 1] = vec4[i * 4 + 1] ?? 0;
        centers[i * 3 + 2] = vec4[i * 4 + 2] ?? 0;
      }
      this.splat.setSortCenters(centers);
    }
    const now = performance.now();
    if (
      fallback.changed &&
      !readback.pending &&
      now - fallback.lastStart >= FALLBACK_SORT_INTERVAL_MS &&
      readback.start()
    ) {
      fallback.changed = false;
      fallback.lastStart = now;
    }
  }

  /**
   * Guard every mutating call.
   *
   * @returns Nothing.
   */
  #assertLive(): void {
    if (this.#disposed) {
      throw new Error('@gameable/splat: this AnimatedSplat has been disposed');
    }
  }
}

/**
 * Build a dynamic splat on an initialised renderer.
 *
 * Asynchronous by contract rather than by need: acquiring the buffers is synchronous today,
 * but the call sits on the boundary where a backend could have to be asked for something, and
 * every caller already awaits.
 *
 * Works on WebGPU and on the WebGL2 fallback. On the fallback there are no `GPUBuffer`s: write
 * through `sink.nodes` with a TSL compute node dispatched over `sink.storageCapacity`.
 *
 * @param renderer An initialised `WebGPURenderer`.
 * @param options Capacity, bounds and draw order.
 * @returns The sink, with its GPU buffers already acquired on WebGPU.
 * @throws {Error} When the renderer is not initialised.
 *
 * @example
 * ```ts
 * import { createAnimatedSplat } from 'gameable/splat';
 *
 * const sink = await createAnimatedSplat(renderer, {
 *   capacity: 250_000,
 *   boundingSphere: { center: [0, 1, 0], radius: 1.4 },
 * });
 * scene.add(sink.object3D);
 *
 * const head = sink.allocate(120_000);
 * // ... compute pass writes sink.buffers.* over [head.offset, head.offset + head.count)
 * sink.markGaussiansChanged();
 *
 * // Either backend: a TSL compute node over the storage nodes, one invocation per slot.
 * import { Fn, instanceIndex, vec4 } from 'three/tsl';
 * const lift = Fn(() => {
 *   sink.nodes.center.element(instanceIndex).assign(vec4(0, 1, 0, 1));
 * })().compute(sink.storageCapacity);
 * renderer.compute(lift);
 * sink.markGaussiansChanged();
 * ```
 */
export function createAnimatedSplat(
  renderer: WebGPURenderer,
  options: CreateAnimatedSplatOptions,
): Promise<AnimatedSplat> {
  initCountingSortPatch();
  const splat = new AnimatedSplat(renderer, options);
  // Unallocated capacity must be invisible, not whatever the driver left in the pages.
  // three zero-fills on upload, but say it explicitly: it costs one upload at build time.
  splat.clearSlots();
  return Promise.resolve(splat);
}

/** Bytes one gaussian occupies across the four buffers. Re-exported for capacity budgeting. */
export { BYTES_PER_GAUSSIAN };
