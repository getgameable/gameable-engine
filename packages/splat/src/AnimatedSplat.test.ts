/**
 * Lifecycle of a dynamic splat: what it allocates on the GPU, and that all of it comes back.
 *
 * Nothing here needs a real GPU. `AnimatedGaussianSplat` builds its TSL graph, its storage
 * attributes and its `CountingSort` on the CPU, and the only thing it asks the renderer for is
 * the backend — so a fake backend that hands out fake `GPUBuffer`s exercises the exact code
 * path `packages/splat/src/backendBuffers.ts` takes against the real one, including which
 * attributes are created and which are destroyed.
 *
 * The two things being pinned are both invisible in a screenshot: nine storage buffers used to
 * outlive every despawned character, and the counting sort used to cost four command encoders
 * and four queue submissions per splat per frame instead of one.
 */
import { PerspectiveCamera, StorageBufferAttribute } from 'three/webgpu';
import type { WebGPURenderer } from 'three/webgpu';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AnimatedSplat, createAnimatedSplat } from './AnimatedSplat.js';
import { acquireStorageGPUBuffer, releaseStorageAttribute } from './backendBuffers.js';
import { isCountingSortPatched } from './sortPatch.js';

/** The two flags `acquireSplatGPUBuffers` insists on, plus the rest of the real enum. */
const USAGE = {
  MAP_READ: 0x0001,
  MAP_WRITE: 0x0002,
  COPY_SRC: 0x0004,
  COPY_DST: 0x0008,
  INDEX: 0x0010,
  VERTEX: 0x0020,
  UNIFORM: 0x0040,
  STORAGE: 0x0080,
  INDIRECT: 0x0100,
  QUERY_RESOLVE: 0x0200,
} as const;

/** Just enough `GPUBuffer` for the code under test: usage bits and a destroy flag. */
interface FakeGPUBuffer {
  readonly usage: number;
  destroyed: boolean;
  destroy: () => void;
}

/** A fake renderer plus the books it keeps, so a test can assert on both. */
interface Harness {
  readonly renderer: WebGPURenderer;
  /** Attributes the backend has materialised, in creation order. */
  readonly created: object[];
  /** Attributes passed to `destroyAttribute`, in destruction order. */
  readonly destroyed: object[];
  /** Every `renderer.compute` call, with the argument it was given. */
  readonly computes: unknown[];
  /** `queue.writeBuffer` call count — `clearSlots` is the only caller. */
  readonly writes: () => number;
  /** The fake buffer behind an attribute, if the backend ever made one. */
  readonly bufferOf: (attribute: object) => FakeGPUBuffer | undefined;
}

/**
 * A renderer whose backend behaves like `WebGPUBackend` for the four calls this package makes.
 *
 * `createStorageAttribute` is idempotent (upstream early-returns when the buffer exists) and
 * `destroyAttribute` dereferences `data.buffer` unguarded, exactly like
 * `WebGPUAttributeUtils.destroyAttribute` — which is the whole reason `releaseStorageAttribute`
 * checks first.
 *
 * @returns The harness.
 */
function harness(): Harness {
  const data = new Map<object, { buffer: FakeGPUBuffer }>();
  const created: object[] = [];
  const destroyed: object[] = [];
  const computes: unknown[] = [];
  const writeBuffer = vi.fn();

  const backend = {
    isWebGLBackend: false,
    device: { queue: { writeBuffer } },
    createStorageAttribute(attribute: object) {
      if (data.has(attribute)) return;
      created.push(attribute);
      data.set(attribute, {
        buffer: {
          usage: USAGE.STORAGE | USAGE.VERTEX | USAGE.COPY_SRC | USAGE.COPY_DST,
          destroyed: false,
          destroy() {
            this.destroyed = true;
          },
        },
      });
    },
    get(attribute: object) {
      return data.get(attribute);
    },
    destroyAttribute(attribute: object) {
      // Mirrors upstream: `data.buffer.destroy()` with no guard, so it throws for an attribute
      // the backend never saw. `releaseStorageAttribute` is what keeps that from happening.
      data.get(attribute)!.buffer.destroy();
      data.delete(attribute);
      destroyed.push(attribute);
    },
  };

  const renderer = {
    backend,
    compute: (nodes: unknown) => {
      computes.push(nodes);
    },
  };

  return {
    renderer: renderer as unknown as WebGPURenderer,
    created,
    destroyed,
    computes,
    writes: () => writeBuffer.mock.calls.length,
    bufferOf: (attribute) => data.get(attribute)?.buffer,
  };
}

/**
 * Pretend the renderer drew a frame: materialise every storage attribute the splat owns.
 *
 * Only the four gaussian buffers are created by `createAnimatedSplat`; the sort's four are
 * created by three on the first compute dispatch, which no fake can reach.
 *
 * @param splat The splat.
 * @param test The harness whose backend should materialise them.
 * @returns The attributes, captured before any dispose clears anything.
 */
function materialise(splat: AnimatedSplat, test: Harness): object[] {
  const attributes = [...splat.splat.storageAttributes()];
  const backend = (
    test.renderer as unknown as { backend: { createStorageAttribute: (a: object) => void } }
  ).backend;
  for (const attribute of attributes) backend.createStorageAttribute(attribute);
  return attributes;
}

/**
 * A small dynamic splat on a fake renderer.
 *
 * @param test The harness supplying the renderer.
 * @param capacity Gaussians to allocate.
 * @returns The splat, with its four gaussian buffers already acquired.
 */
async function makeSplat(test: Harness, capacity = 64): Promise<AnimatedSplat> {
  return createAnimatedSplat(test.renderer, {
    capacity,
    boundingSphere: { center: [0, 1, 0], radius: 1.5 },
  });
}

beforeEach(() => {
  // `backendBuffers.ts` reads the WebGPU usage enum, which node does not define.
  (globalThis as unknown as Record<string, unknown>).GPUBufferUsage = USAGE;
});

describe('AnimatedSplat.dispose', () => {
  it('destroys every storage buffer it owns: four gaussian, four sort', async () => {
    const test = harness();
    const splat = await makeSplat(test);
    const attributes = materialise(splat, test);

    // centre, covarianceA, covarianceB, colour + order, bin, histogram, offset.
    expect(attributes).toHaveLength(8);
    expect(attributes.every((a) => test.bufferOf(a)?.destroyed === false)).toBe(true);

    splat.dispose();

    expect(test.destroyed).toHaveLength(8);
    expect(new Set(test.destroyed)).toEqual(new Set(attributes));
  });

  it('releases the lazily created spherical-harmonics contribution buffer', async () => {
    const test = harness();
    const splat = await makeSplat(test);

    // `ensureSphericalHarmonicsContributionBuffer` only runs on the WebGPU SH pre-pass, which
    // degree-0 dynamic mode never takes. Add the field exactly as it would, and assert the
    // buffer is picked up rather than left behind.
    const buffers = (splat.splat as unknown as { _buffers: Record<string, unknown> })._buffers;
    const contribution = { dispose: vi.fn() };
    buffers.sphericalHarmonicsContributionRead = { isNode: true, value: contribution };

    const attributes = materialise(splat, test);
    expect(attributes).toHaveLength(9);
    expect(attributes).toContain(contribution);

    splat.dispose();

    expect(test.destroyed).toContain(contribution);
    expect(contribution.dispose).toHaveBeenCalledTimes(1);
  });

  it('is idempotent: a second call destroys nothing and does not throw', async () => {
    const test = harness();
    const splat = await makeSplat(test);
    materialise(splat, test);

    splat.dispose();
    const after = test.destroyed.length;

    expect(() => {
      splat.dispose();
    }).not.toThrow();
    expect(test.destroyed).toHaveLength(after);
  });

  it('survives a splat disposed before its buffers were ever uploaded', async () => {
    const test = harness();
    const splat = await makeSplat(test);

    // Only the four gaussian attributes exist on the backend; the sort's four never do, and
    // upstream's `destroyAttribute` would throw on them.
    expect(() => {
      splat.dispose();
    }).not.toThrow();
    expect(test.destroyed).toHaveLength(4);
  });

  it('detaches from the scene graph', async () => {
    const test = harness();
    const splat = await makeSplat(test);
    const camera = new PerspectiveCamera();
    camera.add(splat.object3D);

    splat.dispose();

    expect(splat.object3D.parent).toBeNull();
    expect(camera.children).toHaveLength(0);
  });

  it('makes every mutating method throw', async () => {
    const test = harness();
    const splat = await makeSplat(test);
    const range = splat.allocate(8);
    splat.dispose();
    const writesBefore = test.writes();

    const message = /has been disposed/;
    expect(() => splat.allocate(1)).toThrow(message);
    expect(() => {
      splat.free(range);
    }).toThrow(message);
    expect(() => {
      splat.clearSlots();
    }).toThrow(message);
    expect(() => {
      splat.markGaussiansChanged();
    }).toThrow(message);
    expect(() => {
      splat.setBoundingSphere([0, 0, 0], 1);
    }).toThrow(message);

    // They throw before touching the queue: writing to a destroyed buffer is a device error.
    expect(test.writes()).toBe(writesBefore);

    // Reads stay readable: disposal is not a reason to make a size unavailable.
    expect(splat.capacity).toBe(64);
  });
});

describe('AnimatedGaussianSplat.updateSort', () => {
  it('dispatches the counting sort as one renderer.compute call, not four', async () => {
    // `createAnimatedSplat` applies the prototype patch; this is what a game gets.
    expect(isCountingSortPatched()).toBe(true);
    const test = harness();
    const splat = await makeSplat(test);
    const camera = new PerspectiveCamera();
    camera.updateMatrixWorld(true);

    expect(splat.splat.updateSort(test.renderer, camera)).toBe(true);

    expect(test.computes).toHaveLength(1);
    expect(test.computes[0]).toHaveLength(4);
    // reset -> histogram -> prefix -> scatter, in that order, inside one pass.
    const sort = (splat.splat as unknown as { _sort: Record<string, unknown> })._sort;
    expect(test.computes[0]).toEqual([
      sort._resetNode,
      sort._histogramNode,
      sort._prefixNode,
      sort._scatterNode,
    ]);
  });

  it('falls back to upstream’s four calls when a pass node is missing', async () => {
    const test = harness();
    const splat = await makeSplat(test);
    const camera = new PerspectiveCamera();
    camera.updateMatrixWorld(true);

    // A three upgrade that renames the private nodes must degrade, not skip the sort.
    const sort = (splat.splat as unknown as { _sort: Record<string, unknown> })._sort;
    sort._prefixNode = null;

    expect(splat.splat.updateSort(test.renderer, camera)).toBe(true);
    expect(test.computes).toHaveLength(4);
  });

  it('skips the dispatch until the camera turns, and markGaussiansChanged forces it', async () => {
    const test = harness();
    const splat = await makeSplat(test);
    const camera = new PerspectiveCamera();
    camera.updateMatrixWorld(true);

    expect(splat.splat.updateSort(test.renderer, camera)).toBe(true);
    expect(splat.splat.updateSort(test.renderer, camera)).toBe(false);
    expect(test.computes).toHaveLength(1);

    splat.markGaussiansChanged();

    expect(splat.splat.updateSort(test.renderer, camera)).toBe(true);
    expect(test.computes).toHaveLength(2);
  });
});

describe('AnimatedSplat colour convention', () => {
  it("assumes sRGB bytes unless told 'linear', and keeps the answer on the fork", async () => {
    const test = harness();
    const photographic = await makeSplat(test);
    expect(photographic.splat.colorSpace).toBe('srgb');

    const linear = await createAnimatedSplat(test.renderer, {
      capacity: 8,
      colorSpace: 'linear',
    });
    expect(linear.splat.colorSpace).toBe('linear');
    expect(linear.splat.srgbOutput).toBeNull();
  });

  it('refuses any other colour space name', () => {
    const test = harness();
    expect(() =>
      createAnimatedSplat(test.renderer, {
        capacity: 8,
        colorSpace: 'rec709' as unknown as 'srgb',
      }),
    ).toThrow(RangeError);
  });
});

describe('one storage attribute a producer writes itself', () => {
  it('is materialised once, handed back as its GPU buffer and given back on release', () => {
    const test = harness();
    const attribute = new StorageBufferAttribute(new Float32Array(16), 4);
    const buffer = acquireStorageGPUBuffer(test.renderer, attribute);
    expect(buffer).toBe(test.bufferOf(attribute));
    expect(acquireStorageGPUBuffer(test.renderer, attribute)).toBe(buffer);
    expect(test.created).toEqual([attribute]);
    expect(releaseStorageAttribute(test.renderer, attribute)).toBe(true);
    expect(test.destroyed).toEqual([attribute]);
    expect(releaseStorageAttribute(test.renderer, attribute)).toBe(false);
  });
});
