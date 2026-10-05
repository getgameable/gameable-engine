import { beforeEach, describe, expect, it } from 'vitest';

import type { PatchableAdapterPrototype } from './patches.js';
import {
  DEFAULT_MAX_STORAGE_BUFFERS_PER_SHADER_STAGE,
  initWebGPUPatches,
  isWebGPUPatched,
} from './patches.js';

/** Descriptors the fake adapter was asked for, newest last. */
let seen: (GPUDeviceDescriptor | undefined)[] = [];

/** Stands in for `GPUAdapter`, so tests never need a real one. */
class FakeAdapter {
  /** What the fake adapter claims to support. */
  limits: { maxStorageBuffersPerShaderStage?: number };

  /** Features the fake adapter claims to have. */
  features: Set<string>;

  /**
   * Build a fake adapter.
   *
   * @param maxStorageBuffers Limit the adapter reports, or `'none'` to report none.
   * @param features Feature names the adapter has.
   */
  constructor(maxStorageBuffers: number | 'none' = 64, features: string[] = []) {
    this.limits =
      maxStorageBuffers === 'none' ? {} : { maxStorageBuffersPerShaderStage: maxStorageBuffers };
    this.features = new Set(features);
  }

  /**
   * Record the descriptor the patch produced.
   *
   * @param descriptor Descriptor as the patch built it.
   * @returns A stub device.
   */
  requestDevice(descriptor?: GPUDeviceDescriptor): Promise<GPUDevice> {
    seen.push(descriptor);
    return Promise.resolve({ label: 'fake' } as GPUDevice);
  }
}

/**
 * A fresh, unpatched prototype for each test.
 *
 * @returns The prototype of a new subclass of {@link FakeAdapter}.
 */
function freshPrototype(): PatchableAdapterPrototype {
  class Adapter extends FakeAdapter {}
  return Adapter.prototype;
}

/**
 * The limits of the last descriptor the fake adapter received.
 *
 * @returns The `requiredLimits` record.
 */
function lastLimits(): Record<string, number | undefined> {
  return seen.at(-1)?.requiredLimits ?? {};
}

beforeEach(() => {
  seen = [];
});

describe('initWebGPUPatches', () => {
  it('raises maxStorageBuffersPerShaderStage to the default', async () => {
    const target = freshPrototype();
    expect(initWebGPUPatches({ target })).toBe(true);

    await new (target.constructor as new () => FakeAdapter)().requestDevice();

    expect(lastLimits().maxStorageBuffersPerShaderStage).toBe(
      DEFAULT_MAX_STORAGE_BUFFERS_PER_SHADER_STAGE,
    );
  });

  it('never asks for more than the adapter reports', async () => {
    const target = freshPrototype();
    initWebGPUPatches({ target, maxStorageBuffersPerShaderStage: 32 });
    const adapter = new FakeAdapter(8);
    Object.setPrototypeOf(adapter, target);

    await adapter.requestDevice();

    expect(lastLimits().maxStorageBuffersPerShaderStage).toBe(8);
  });

  it('assumes the WebGPU default of 8 when the adapter reports no limit', async () => {
    const target = freshPrototype();
    initWebGPUPatches({ target });
    const adapter = new FakeAdapter('none');
    Object.setPrototypeOf(adapter, target);

    await adapter.requestDevice();

    expect(lastLimits().maxStorageBuffersPerShaderStage).toBe(8);
  });

  it('honours an explicit request', async () => {
    const target = freshPrototype();
    initWebGPUPatches({ target, maxStorageBuffersPerShaderStage: 12 });
    const adapter = new FakeAdapter(64);
    Object.setPrototypeOf(adapter, target);

    await adapter.requestDevice();

    expect(lastLimits().maxStorageBuffersPerShaderStage).toBe(12);
  });

  it('is additive: it never lowers what the caller asked for', async () => {
    const target = freshPrototype();
    initWebGPUPatches({ target, maxStorageBuffersPerShaderStage: 10 });
    const adapter = new FakeAdapter(64);
    Object.setPrototypeOf(adapter, target);

    await adapter.requestDevice({ requiredLimits: { maxStorageBuffersPerShaderStage: 20 } });

    expect(lastLimits().maxStorageBuffersPerShaderStage).toBe(20);
  });

  it('keeps the caller’s other limits and descriptor fields', async () => {
    const target = freshPrototype();
    initWebGPUPatches({ target });
    const adapter = new FakeAdapter(64);
    Object.setPrototypeOf(adapter, target);

    await adapter.requestDevice({
      label: 'three',
      requiredLimits: { maxBufferSize: 1234, maxComputeWorkgroupSizeX: 256 },
    });

    expect(seen.at(-1)?.label).toBe('three');
    expect(lastLimits().maxBufferSize).toBe(1234);
    expect(lastLimits().maxComputeWorkgroupSizeX).toBe(256);
    expect(lastLimits().maxStorageBuffersPerShaderStage).toBe(10);
  });

  it('leaves requiredFeatures alone by default', async () => {
    const target = freshPrototype();
    initWebGPUPatches({ target });
    const adapter = new FakeAdapter(64, ['timestamp-query']);
    Object.setPrototypeOf(adapter, target);

    await adapter.requestDevice();

    expect(seen.at(-1)?.requiredFeatures).toBeUndefined();
  });

  it('adds timestamp-query when asked and the adapter has it', async () => {
    const target = freshPrototype();
    initWebGPUPatches({ target, timestampQuery: true });
    const adapter = new FakeAdapter(64, ['timestamp-query']);
    Object.setPrototypeOf(adapter, target);

    await adapter.requestDevice({ requiredFeatures: ['float32-filterable'] });

    expect([...(seen.at(-1)?.requiredFeatures ?? [])]).toEqual([
      'float32-filterable',
      'timestamp-query',
    ]);
  });

  it('does not add timestamp-query when the adapter lacks it', async () => {
    const target = freshPrototype();
    initWebGPUPatches({ target, timestampQuery: true });
    const adapter = new FakeAdapter(64, []);
    Object.setPrototypeOf(adapter, target);

    await adapter.requestDevice();

    expect(seen.at(-1)?.requiredFeatures).toBeUndefined();
  });

  it('does not add timestamp-query twice', async () => {
    const target = freshPrototype();
    initWebGPUPatches({ target, timestampQuery: true });
    const adapter = new FakeAdapter(64, ['timestamp-query']);
    Object.setPrototypeOf(adapter, target);

    await adapter.requestDevice({ requiredFeatures: ['timestamp-query'] });

    expect([...(seen.at(-1)?.requiredFeatures ?? [])]).toEqual(['timestamp-query']);
  });

  it('is idempotent: a second call does not wrap the method again', async () => {
    const target = freshPrototype();
    initWebGPUPatches({ target });
    const wrapped = target.requestDevice;

    expect(initWebGPUPatches({ target })).toBe(true);

    expect(target.requestDevice).toBe(wrapped);
    const adapter = new FakeAdapter(64);
    Object.setPrototypeOf(adapter, target);
    await adapter.requestDevice();
    expect(seen).toHaveLength(1);
  });

  it('raises the target on a later call, and never lowers it', async () => {
    const target = freshPrototype();
    initWebGPUPatches({ target, maxStorageBuffersPerShaderStage: 10 });
    initWebGPUPatches({ target, maxStorageBuffersPerShaderStage: 16 });
    initWebGPUPatches({ target, maxStorageBuffersPerShaderStage: 4 });

    const adapter = new FakeAdapter(64);
    Object.setPrototypeOf(adapter, target);
    await adapter.requestDevice();

    expect(lastLimits().maxStorageBuffersPerShaderStage).toBe(16);
  });

  it('turns timestamp-query on through a later call', async () => {
    const target = freshPrototype();
    initWebGPUPatches({ target });
    initWebGPUPatches({ target, timestampQuery: true });

    const adapter = new FakeAdapter(64, ['timestamp-query']);
    Object.setPrototypeOf(adapter, target);
    await adapter.requestDevice();

    expect([...(seen.at(-1)?.requiredFeatures ?? [])]).toEqual(['timestamp-query']);
  });

  it('reports whether a prototype is patched', () => {
    const target = freshPrototype();
    expect(isWebGPUPatched(target)).toBe(false);
    initWebGPUPatches({ target });
    expect(isWebGPUPatched(target)).toBe(true);
  });

  it('is a no-op without WebGPU, which is what Node is', () => {
    // No `target`, and Node has no `navigator.gpu`.
    expect(initWebGPUPatches()).toBe(false);
    expect(isWebGPUPatched()).toBe(false);
  });
});
