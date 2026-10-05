// The one seam between the character runtime and the splat renderer.
//
// A character is ONE animated gaussian splat object: head, teeth, clothes, hair
// and eyes all live in slot ranges of the same buffers, so the whole avatar
// sorts as a unit. `gameable/splat` implements this over its fork of three
// r186's `GaussianSplat`; this package never imports it, so the contract is
// declared here and the tests drive a fake.
//
// BUFFER LAYOUT — three r186's `createStorageBuffers` (GaussianSplat.js), NOT the
// CPU-side `BufferAttribute` shapes. A `StorageBufferAttribute` of itemSize 3 is
// padded to vec4 by three and the attribute is MUTATED in place, so anything this
// package allocates itself must be itemSize 4 or 1:
//
//   center       array<vec4<f32>>   xyz = centre, w unused (write 1.0)
//   covarianceA  array<vec4<f32>>   (c00, c01, c02, c11)
//   covarianceB  array<vec4<f32>>   (c12, c22, 0, 0)
//   color        array<u32>         pack4x8unorm(r, g, b, opacity)
//
// The six covariance terms are the UPPER TRIANGLE in
// `GaussianSplatUtils.writeCovariance` order (c00, c01, c02, c11, c12, c22); the
// vertex shader rebuilds cov0 = (A.x, A.y, A.z), cov1 = (A.y, A.w, B.x),
// cov2 = (A.z, B.x, B.y). Writing them in any other order renders a plausible but
// wrong ellipsoid, which is exactly the kind of defect that has no error message —
// hence `test/covariance.test.ts`, which pins this against a TS port of three's own
// writer.

/** A contiguous run of splat slots owned by one branch for its whole life. */
export interface SlotRange {
  /** First slot index. */
  readonly offset: number;
  /** Slot count. Constant: culled texels write opacity 0 rather than compacting. */
  readonly count: number;
}

/** The GPU buffers a lift writes into. All four are indexed by absolute slot. */
export interface SplatSinkBuffers {
  /** `array<vec4<f32>>`: xyz = centre in scene metres, w unused. */
  readonly center: GPUBuffer;
  /** `array<vec4<f32>>`: (c00, c01, c02, c11). */
  readonly covarianceA: GPUBuffer;
  /** `array<vec4<f32>>`: (c12, c22, 0, 0). */
  readonly covarianceB: GPUBuffer;
  /** `array<u32>`: `pack4x8unorm(vec4f(r, g, b, opacity))`. */
  readonly color: GPUBuffer;
}

/**
 * The splat object a character writes its gaussians into.
 *
 * Implemented by `gameable/splat`'s `AnimatedGaussianSplat`. Slot ranges are
 * allocated once per branch at load and never move: three's `CountingSort` keeps
 * an index -> splat map across frames, so compacting on the GPU would tear the
 * sort during camera motion.
 */
export interface SplatSink {
  /** Total slots. A character must fit inside it or `allocate` throws. */
  readonly capacity: number;
  /** Reserve `count` contiguous slots. Throws when the sink is full. */
  allocate(count: number): SlotRange;
  /** Return a range to the free list. */
  free(range: SlotRange): void;
  readonly buffers: SplatSinkBuffers;
  /**
   * The four buffers as writable TSL storage nodes (`gameable/splat`'s `SplatStorageNodes`),
   * on WebGPU and the WebGL2 fallback. Absent on a sink that only speaks `GPUBuffer`s.
   */
  readonly nodes?: {
    readonly center: import('three/webgpu').StorageBufferNode<'vec4'>;
    readonly covarianceA: import('three/webgpu').StorageBufferNode<'vec4'>;
    readonly covarianceB: import('three/webgpu').StorageBufferNode<'vec4'>;
    readonly color: import('three/webgpu').StorageBufferNode<'uint'>;
  };
  /** Elements per buffer, `capacity` padded to the WebGL PBO shape; set with `nodes`. */
  readonly storageCapacity?: number;
  /** Force a re-sort on the next render, even when the camera has not moved. */
  markGaussiansChanged(): void;
  /** Owner-supplied bounds; the splat object never recomputes them from the GPU. */
  setBoundingSphere(center: [number, number, number], radius: number): void;
  /** Scene node the splats hang under. */
  readonly object3D: import('three/webgpu').Object3D;
  /**
   * Scale each fragment's opacity by a node built from the splat's view-space centre, or
   * null to draw as before. Optional: a sink without it gets no mouth interior.
   */
  setFragmentAlpha?(
    builder: ((view: import('three/webgpu').Node) => import('three/webgpu').Node) | null,
  ): void;
}

// ---------------------------------------------------------------------------
// The fake, for tests.
//
// `gameable/splat` owns the real implementation; this package must not import
// it (the two are built in parallel, and a character has no business knowing how
// a splat object is sorted). So the contract is declared above and exercised
// below — a fake sink that allocates real slot ranges and hands out placeholder
// buffer objects, which is everything a test that never reaches a GPU can use.

import { SlotAllocator } from './render/slotAllocator.js';

/** A fake sink, plus the bookkeeping a test wants to assert on. */
export interface FakeSplatSink extends SplatSink {
  /** How many times a lift asked for a re-sort. */
  readonly sortRequests: number;
  /** The last bounds the owner supplied, or null. */
  readonly bounds: { center: [number, number, number]; radius: number } | null;
  /** Ranges still allocated, in allocation order. */
  readonly live: readonly SlotRange[];
}

/**
 * A `SplatSink` with no GPU behind it.
 *
 * The four buffers are inert placeholders: nothing in a node test dispatches a
 * compute pass, so a `GPUBuffer` only has to be an object identity the code can
 * hold. Everything that IS testable — the slot arithmetic, the double-free
 * refusal, the re-sort request, the bounding sphere — is real.
 *
 * @param capacity Total slots the fake sink hands out, shared by every branch that
 * allocates from it; exceeding it throws exactly as the real sink does.
 * @param object3D The scene node to report as the splat object's node. Tests pass a
 * bare `Object3D`; nothing is ever parented to it here.
 * @returns The sink, plus the test-only `sortRequests`, `bounds` and `live` views
 * over what the code under test asked it to do.
 */
export function createFakeSplatSink(
  capacity: number,
  object3D: SplatSink['object3D'],
): FakeSplatSink {
  const allocator = new SlotAllocator(capacity);
  const live: SlotRange[] = [];
  let sortRequests = 0;
  let bounds: { center: [number, number, number]; radius: number } | null = null;
  const buffer = (label: string): GPUBuffer =>
    ({ label, size: 0, usage: 0, destroy: () => undefined }) as unknown as GPUBuffer;
  const buffers: SplatSinkBuffers = {
    center: buffer('center'),
    covarianceA: buffer('covarianceA'),
    covarianceB: buffer('covarianceB'),
    color: buffer('color'),
  };
  return {
    capacity,
    buffers,
    object3D,
    get sortRequests() {
      return sortRequests;
    },
    get bounds() {
      return bounds;
    },
    get live() {
      return live;
    },
    allocate(count) {
      const range = allocator.allocate(count);
      live.push(range);
      return range;
    },
    free(range) {
      allocator.free(range);
      const index = live.findIndex((r) => r.offset === range.offset && r.count === range.count);
      if (index >= 0) live.splice(index, 1);
    },
    markGaussiansChanged() {
      sortRequests++;
    },
    setBoundingSphere(center, radius) {
      bounds = { center: [...center] as [number, number, number], radius };
    },
  };
}
