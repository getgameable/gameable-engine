import type { WebGPURenderer } from 'three/webgpu';
import { describe, expect, it } from 'vitest';

import { DEFAULT_PIXEL_RATIO_CAP, isWebGPUBackend, resolveEngineConfig } from './engine.js';
import { DEFAULT_MAX_SUBSTEPS } from './loop.js';

/**
 * A renderer stub carrying nothing but a backend.
 *
 * @param backend The `renderer.backend` value to expose.
 * @returns Something `isWebGPUBackend` will accept.
 */
function withBackend(backend: unknown): WebGPURenderer {
  return { backend } as WebGPURenderer;
}

describe('resolveEngineConfig', () => {
  it('applies the documented defaults', () => {
    expect(resolveEngineConfig()).toEqual({
      fixedHz: 60,
      fixedDt: 1 / 60,
      maxSubsteps: DEFAULT_MAX_SUBSTEPS,
      backend: 'auto',
      antialias: true,
      pixelRatioCap: DEFAULT_PIXEL_RATIO_CAP,
      debug: false,
      headless: false,
    });
  });

  it('derives fixedDt from fixedHz', () => {
    expect(resolveEngineConfig({ fixedHz: 120 }).fixedDt).toBeCloseTo(1 / 120, 12);
    expect(resolveEngineConfig({ fixedHz: 30 }).fixedDt).toBeCloseTo(1 / 30, 12);
  });

  it('rejects a non-positive fixedHz', () => {
    expect(() => resolveEngineConfig({ fixedHz: 0 })).toThrow(RangeError);
    expect(() => resolveEngineConfig({ fixedHz: -60 })).toThrow(/fixedHz/);
  });

  it('carries the renderer options through', () => {
    const config = resolveEngineConfig({
      renderer: { backend: 'webgl', antialias: false, pixelRatioCap: 1 },
      debug: true,
      maxSubsteps: 3,
    });

    expect(config.backend).toBe('webgl');
    expect(config.antialias).toBe(false);
    expect(config.pixelRatioCap).toBe(1);
    expect(config.debug).toBe(true);
    expect(config.maxSubsteps).toBe(3);
  });

  it('keeps antialias on when only the backend is given', () => {
    expect(resolveEngineConfig({ renderer: { backend: 'webgpu' } }).antialias).toBe(true);
  });
});

describe('isWebGPUBackend', () => {
  it('is true for a WebGPU backend', () => {
    expect(isWebGPUBackend(withBackend({ isWebGPUBackend: true }))).toBe(true);
  });

  it('is false for the WebGL fallback', () => {
    expect(isWebGPUBackend(withBackend({ isWebGLBackend: true }))).toBe(false);
  });

  it('trusts an explicit false over the absence of isWebGLBackend', () => {
    expect(isWebGPUBackend(withBackend({ isWebGPUBackend: false }))).toBe(false);
  });

  it('falls back to "not the WebGL backend" for an unknown backend', () => {
    expect(isWebGPUBackend(withBackend({}))).toBe(true);
  });

  it('is false when there is no backend at all', () => {
    expect(isWebGPUBackend(withBackend(undefined))).toBe(false);
  });
});
