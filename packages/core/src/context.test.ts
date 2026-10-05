import { describe, expect, it } from 'vitest';
import { requireRenderContext, type HostContext } from './context.js';
import { ModuleError } from './module.js';

describe('requireRenderContext', () => {
  it('returns the same object when it has a renderer', () => {
    const ctx = { renderer: {}, scene: {}, camera: {} } as unknown as HostContext;
    expect(requireRenderContext(ctx, 'splat')).toBe(ctx);
  });
  it('passes on the renderer alone', () => {
    const ctx = { renderer: {} } as unknown as HostContext;
    expect(requireRenderContext(ctx, 'splat')).toBe(ctx);
  });
  it('throws when scene and camera exist but the renderer does not', () => {
    const ctx = { scene: {}, camera: {} } as unknown as HostContext;
    expect(() => requireRenderContext(ctx, 'splat')).toThrow(ModuleError);
  });
  it('names the module that cannot run headless', () => {
    const ctx = {} as unknown as HostContext;
    expect(() => requireRenderContext(ctx, 'splat')).toThrow(ModuleError);
    expect(() => requireRenderContext(ctx, 'splat')).toThrow(/splat.*headless/);
  });
  it('carries the module id on the error', () => {
    const ctx = {} as unknown as HostContext;
    try {
      requireRenderContext(ctx, 'splat');
      expect.unreachable();
    } catch (error) {
      expect((error as ModuleError).moduleId).toBe('splat');
    }
  });
});
