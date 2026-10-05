/**
 * A dynamic splat on the WebGL2 fallback: padded instanced storage, a TSL face, and the CPU
 * sort fed by a fenced readback of the centres.
 *
 * No GL context in node, so the backend and its `gl` are fakes that keep books. They follow
 * r186's `WebGLBackend` where it matters: a storage attribute gets a `DualAttributeData` (two
 * GL buffers, `bufferGPU` the active one), `destroyAttribute` deletes only the active one, and
 * a fence stays unsignalled until the test says the GPU is done.
 */
import { PerspectiveCamera, Scene, StorageInstancedBufferAttribute } from 'three/webgpu';
import type { WebGPURenderer } from 'three/webgpu';
import { describe, expect, it, vi } from 'vitest';

import { createAnimatedSplat } from './AnimatedSplat.js';
import { padStorageCapacity, SplatUnsupportedError } from './three-fork/AnimatedGaussianSplat.js';
import { AnimatedGaussianSplat } from './three-fork/AnimatedGaussianSplat.js';

/** The WebGL2 enums the code under test reads. */
const GL = {
  COPY_READ_BUFFER: 0x8f36,
  COPY_WRITE_BUFFER: 0x8f37,
  DYNAMIC_COPY: 0x88ea,
  SYNC_GPU_COMMANDS_COMPLETE: 0x9117,
  ALREADY_SIGNALED: 0x911a,
  TIMEOUT_EXPIRED: 0x911b,
  CONDITION_SATISFIED: 0x911c,
  WAIT_FAILED: 0x911d,
} as const;

/** A fake GL buffer: an id and its bytes. */
interface FakeBuffer {
  readonly id: number;
  bytes: Uint8Array;
  deleted: boolean;
}

/** The fake renderer plus what a test wants to steer and inspect. */
interface Harness {
  readonly renderer: WebGPURenderer;
  /** Every GL buffer ever created, staging buffers included. */
  readonly buffers: FakeBuffer[];
  /** Let every pending fence signal. */
  signal(): void;
  /** Materialise an attribute as three would on its first compute or draw. */
  upload(attribute: object): FakeBuffer;
  /** GL call names, in order. */
  readonly calls: string[];
}

/**
 * A renderer on a fake WebGL backend.
 *
 * @returns The harness.
 */
function harness(): Harness {
  const buffers: FakeBuffer[] = [];
  const calls: string[] = [];
  const bound = new Map<number, FakeBuffer | null>();
  const data = new Map<
    object,
    { bufferGPU?: FakeBuffer; buffers?: FakeBuffer[]; byteLength?: number }
  >();
  let signalled = false;
  const newBuffer = (bytes = 0): FakeBuffer => {
    const b = { id: buffers.length + 1, bytes: new Uint8Array(bytes), deleted: false };
    buffers.push(b);
    return b;
  };
  const target = (t: number): FakeBuffer => {
    const b = bound.get(t);
    if (b === undefined || b === null) throw new Error(`nothing bound to 0x${t.toString(16)}`);
    return b;
  };

  const gl = {
    ...GL,
    createBuffer: () => (calls.push('createBuffer'), newBuffer()),
    deleteBuffer: (b: FakeBuffer) => {
      calls.push('deleteBuffer');
      b.deleted = true;
    },
    bindBuffer: (t: number, b: FakeBuffer | null) => bound.set(t, b),
    bufferData: (t: number, size: number) => {
      target(t).bytes = new Uint8Array(size);
    },
    bufferSubData: (t: number, offset: number, src: Uint8Array, srcOffset: number, n: number) => {
      calls.push('bufferSubData');
      target(t).bytes.set(src.subarray(srcOffset, srcOffset + n), offset);
    },
    copyBufferSubData: (r: number, w: number, ro: number, wo: number, n: number) => {
      calls.push('copyBufferSubData');
      target(w).bytes.set(target(r).bytes.subarray(ro, ro + n), wo);
    },
    getBufferSubData: (t: number, offset: number, dst: Float32Array) => {
      calls.push('getBufferSubData');
      new Uint8Array(dst.buffer, dst.byteOffset, dst.byteLength).set(
        target(t).bytes.subarray(offset, offset + dst.byteLength),
      );
    },
    fenceSync: () => {
      calls.push('fenceSync');
      signalled = false;
      return {};
    },
    flush: () => calls.push('flush'),
    clientWaitSync: () => (signalled ? GL.ALREADY_SIGNALED : GL.TIMEOUT_EXPIRED),
    deleteSync: () => calls.push('deleteSync'),
  };

  const upload = (attribute: object): FakeBuffer => {
    // Like WebGLBackend.createStorageAttribute: nothing happens when the backend has a record.
    const existing = data.get(attribute);
    if (existing !== undefined) {
      if (existing.bufferGPU === undefined) throw new Error('has() is true but there is no buffer');
      return existing.bufferGPU;
    }
    const array = (attribute as { array: Float32Array | Uint32Array }).array;
    const a = newBuffer(array.byteLength);
    const b = newBuffer(array.byteLength);
    a.bytes.set(new Uint8Array(array.buffer, array.byteOffset, array.byteLength));
    data.set(attribute, { bufferGPU: a, buffers: [a, b], byteLength: array.byteLength });
    return a;
  };

  const backend = {
    isWebGLBackend: true,
    gl,
    // Get-or-create, like three's DataMap: asking about an attribute leaves a record behind.
    get: (attribute: object) => {
      let d = data.get(attribute);
      if (d === undefined) data.set(attribute, (d = {}));
      return d;
    },
    has: (attribute: object) => data.has(attribute),
    destroyAttribute: (attribute: object) => {
      // Mirrors WebGLAttributeUtils.destroyAttribute: the active buffer only.
      const d = data.get(attribute);
      if (d?.bufferGPU !== undefined) gl.deleteBuffer(d.bufferGPU);
      data.delete(attribute);
    },
  };

  return {
    renderer: { backend } as unknown as WebGPURenderer,
    buffers,
    calls,
    signal: () => {
      signalled = true;
    },
    upload,
  };
}

/** The fork's private fields these tests look at. */
interface ForkPrivate {
  _buffers: Record<string, { value: object; isPBO?: boolean }>;
  _sort: { orderAttribute: { array: Uint32Array } };
}

describe('padStorageCapacity', () => {
  it('pads to the PBO texture three builds on the WebGL fallback', () => {
    // 20000 is the case that overflowed glTexSubImage2D in the spike; 256 x 79 worked.
    expect(padStorageCapacity(20_000)).toBe(20_224);
    expect(padStorageCapacity(262_144)).toBe(262_144);
    expect(padStorageCapacity(250_000)).toBe(250_368);
    expect(padStorageCapacity(64)).toBe(64);
    expect(padStorageCapacity(1)).toBe(1);
    for (let n = 1; n < 5000; n += 37) expect(padStorageCapacity(n)).toBeGreaterThanOrEqual(n);
  });
});

describe('AnimatedSplat on the WebGL fallback', () => {
  it('allocates padded, instanced storage and exposes it as TSL nodes', async () => {
    const test = harness();
    const sink = await createAnimatedSplat(test.renderer, { capacity: 20_000 });
    const fork = sink.splat as unknown as ForkPrivate;

    expect(sink.capacity).toBe(20_000);
    expect(sink.storageCapacity).toBe(20_224);
    expect(sink.available).toBe(20_000);
    for (const [node, field] of [
      [sink.nodes.center, 'centerRead'],
      [sink.nodes.covarianceA, 'covarianceARead'],
      [sink.nodes.covarianceB, 'covarianceBRead'],
      [sink.nodes.color, 'colorRead'],
    ] as const) {
      const attribute = fork._buffers[field].value;
      // The writable node wraps the very attribute the draw reads.
      expect(node.value).toBe(attribute);
      expect(attribute).toBeInstanceOf(StorageInstancedBufferAttribute);
      expect((attribute as { count: number }).count).toBe(20_224);
    }
    expect(() => sink.buffers).toThrow(/WebGL2 fallback.*sink\.nodes/);
  });

  it('draws in index order instead of throwing until centres arrive', async () => {
    const test = harness();
    const sink = await createAnimatedSplat(test.renderer, { capacity: 64 });
    const camera = new PerspectiveCamera();
    camera.updateMatrixWorld(true);

    expect(sink.splat.updateSort(test.renderer, camera)).toBe(false);
    // The storage reads were still switched to PBO textures, which the draw needs.
    const fork = sink.splat as unknown as ForkPrivate;
    expect(fork._buffers.centerRead.isPBO).toBe(true);
  });

  it('sorts back to front from a fenced readback, without ever waiting on the GPU', async () => {
    const test = harness();
    const sink = await createAnimatedSplat(test.renderer, {
      capacity: 4,
      boundingSphere: { center: [0, 0, -2.5], radius: 2 },
    });
    const scene = new Scene();
    scene.add(sink.object3D);
    const camera = new PerspectiveCamera();
    camera.updateMatrixWorld(true);
    const render = (): void => {
      sink.object3D.onBeforeRender(
        test.renderer as never,
        scene,
        camera,
        sink.splat.geometry,
        sink.splat.material,
        null as never,
      );
    };

    // The producer's compute wrote z = -1, -4, -2, -3 into slots 0..3 of the active buffer.
    const center = (sink.nodes.center as unknown as { value: object }).value;
    const active = test.upload(center);
    new Float32Array(active.bytes.buffer).set([0, 0, -1, 1, 0, 0, -4, 1, 0, 0, -2, 1, 0, 0, -3, 1]);

    sink.markGaussiansChanged();
    render(); // starts the copy and drops a fence
    expect(test.calls.filter((c) => c === 'copyBufferSubData')).toHaveLength(1);
    expect(test.calls).toContain('flush');

    render(); // the GPU is not done: no read, no second copy, nothing stalls
    expect(test.calls).not.toContain('getBufferSubData');
    expect(test.calls.filter((c) => c === 'copyBufferSubData')).toHaveLength(1);

    test.signal();
    render(); // lands the readback and sorts with this frame's camera
    expect(test.calls.filter((c) => c === 'getBufferSubData')).toHaveLength(1);

    const order = Array.from((sink.splat as unknown as ForkPrivate)._sort.orderAttribute.array);
    expect(order).toEqual([1, 3, 2, 0]);

    // No change since, so no new readback.
    render();
    expect(test.calls.filter((c) => c === 'copyBufferSubData')).toHaveLength(1);
  });

  it('reads the centres back at most every 50 ms while the gaussians keep changing', async () => {
    const test = harness();
    const sink = await createAnimatedSplat(test.renderer, { capacity: 4 });
    test.upload((sink.nodes.center as unknown as { value: object }).value);
    let now = 1000;
    const clock = vi.spyOn(performance, 'now').mockImplementation(() => now);
    const frame = (): void => {
      sink.markGaussiansChanged();
      sink.object3D.onBeforeRender(
        test.renderer as never,
        new Scene(),
        new PerspectiveCamera(),
        sink.splat.geometry,
        sink.splat.material,
        null as never,
      );
    };
    const copies = (): number => test.calls.filter((c) => c === 'copyBufferSubData').length;
    try {
      frame(); // starts the first
      test.signal();
      now += 16;
      frame(); // lands it; the next may not start yet
      expect(copies()).toBe(1);
      now += 16;
      frame();
      expect(copies()).toBe(1);
      now += 20; // 52 ms after the first start
      frame();
      expect(copies()).toBe(2);
    } finally {
      clock.mockRestore();
    }
  });
  it('frees both transform-feedback buffers and the staging buffer on dispose', async () => {
    const test = harness();
    const sink = await createAnimatedSplat(test.renderer, { capacity: 4 });
    const attributes = [...sink.splat.storageAttributes()].slice(0, 4);
    for (const attribute of attributes) test.upload(attribute);
    sink.markGaussiansChanged();
    sink.object3D.onBeforeRender(
      test.renderer as never,
      new Scene(),
      new PerspectiveCamera(),
      sink.splat.geometry,
      sink.splat.material,
      null as never,
    );

    sink.dispose();

    // 4 attributes x 2 buffers + 1 staging buffer, all deleted.
    expect(test.buffers).toHaveLength(9);
    expect(test.buffers.every((b) => b.deleted)).toBe(true);
  });

  it('leaves no backend record behind before three has made the buffers', async () => {
    const test = harness();
    // createAnimatedSplat clears every slot; the start of a readback asks about the centres.
    const sink = await createAnimatedSplat(test.renderer, { capacity: 4 });
    sink.markGaussiansChanged();
    sink.object3D.onBeforeRender(
      test.renderer as never,
      new Scene(),
      new PerspectiveCamera(),
      sink.splat.geometry,
      sink.splat.material,
      null as never,
    );
    sink.clearSlots();

    const backend = (test.renderer as unknown as { backend: { has: (a: object) => boolean } })
      .backend;
    for (const attribute of sink.splat.storageAttributes()) {
      expect(backend.has(attribute)).toBe(false);
    }
    // So three's first compute still allocates them.
    expect(() =>
      test.upload((sink.nodes.center as unknown as { value: object }).value),
    ).not.toThrow();
  });

  it('clears slots in both GL buffers once they exist', async () => {
    const test = harness();
    const sink = await createAnimatedSplat(test.renderer, { capacity: 4 });
    const color = (sink.nodes.color as unknown as { value: { array: Uint32Array } }).value;
    color.array.fill(0xffffffff);
    const active = test.upload(color);
    const [a, b] = [active, test.buffers[test.buffers.indexOf(active) + 1]];

    sink.clearSlots({ offset: 1, count: 2 });

    expect(Array.from(color.array)).toEqual([0xffffffff, 0, 0, 0xffffffff]);
    expect(Array.from(new Uint32Array(a.bytes.buffer))).toEqual([0xffffffff, 0, 0, 0xffffffff]);
    expect(Array.from(new Uint32Array(b.bytes.buffer)).slice(1, 3)).toEqual([0, 0]);
  });
});

describe('AnimatedGaussianSplat.setSortCenters', () => {
  it('refuses a static splat, which sorts from its own geometry', async () => {
    const { BufferAttribute, BufferGeometry } = await import('three/webgpu');
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(new Float32Array(3), 3));
    geometry.setAttribute('covariance', new BufferAttribute(new Float32Array(6), 6));
    geometry.setAttribute('color', new BufferAttribute(new Uint8Array(4), 4));
    const splat = new AnimatedGaussianSplat(geometry);

    expect(() => {
      splat.setSortCenters(new Float32Array(3));
    }).toThrow(SplatUnsupportedError);
  });
});
