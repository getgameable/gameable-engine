/**
 * The load refuses a renderer it cannot draw on, with a message that says so: a renderer that has
 * not been initialised, and the WebGL2 fallback when the app refuses it. Drawing nothing would be the
 * failure with no symptom.
 */
import type { WebGPURenderer } from 'three/webgpu';
import { describe, expect, it } from 'vitest';

import { GameableCharacterError, isSoftwareRenderer, loadGameableCharacter } from './index.js';

describe('loadGameableCharacter', () => {
  it('refuses the WebGL2 fallback with webgpu-required when told to', async () => {
    const renderer = {
      _initialized: true,
      backend: { isWebGLBackend: true },
    } as unknown as WebGPURenderer;
    const load = loadGameableCharacter(renderer, 'https://example.test/character.json', {
      allowWebGL: false,
    });
    await expect(load).rejects.toBeInstanceOf(GameableCharacterError);
    await expect(load).rejects.toMatchObject({ code: 'webgpu-required' });
    await expect(load).rejects.toThrow(/allowWebGL: false/);
  });

  it('refuses a renderer before init() with renderer-not-ready', async () => {
    // As three makes one: the backend exists from the constructor, `init()` has not run.
    const renderer = {
      _initialized: false,
      backend: { isWebGLBackend: false },
    } as unknown as WebGPURenderer;
    await expect(
      loadGameableCharacter(renderer, 'https://example.test/character.json'),
    ).rejects.toMatchObject({ code: 'renderer-not-ready' });
  });
  it('refuses a software renderer with software-renderer, unless told to draw anyway', async () => {
    const gl = {
      RENDERER: 1,
      getExtension: () => ({ UNMASKED_RENDERER_WEBGL: 2 }),
      getParameter: (p: number) =>
        p === 2
          ? 'ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero)), SwiftShader driver)'
          : 'WebKit WebGL',
    };
    const renderer = {
      _initialized: true,
      backend: { isWebGLBackend: true, gl },
    } as unknown as WebGPURenderer;
    expect(isSoftwareRenderer(renderer)).toBe(true);
    await expect(
      loadGameableCharacter(renderer, 'https://example.test/character.json'),
    ).rejects.toMatchObject({ code: 'software-renderer' });
    // told to draw anyway: it gets past the check (and fails later, on the fetch)
    await expect(
      loadGameableCharacter(renderer, 'https://no.such.host.invalid/character.json', {
        allowSoftwareRenderer: true,
      }),
    ).rejects.toMatchObject({ code: 'load-failed' });
  });

  it('tells a WebGPU fallback adapter, and a real GPU, apart', () => {
    const webgpu = (info: Record<string, unknown>): WebGPURenderer =>
      ({ backend: { device: { adapterInfo: info } } }) as unknown as WebGPURenderer;
    expect(isSoftwareRenderer(webgpu({ isFallbackAdapter: true }))).toBe(true);
    expect(isSoftwareRenderer(webgpu({ vendor: 'google', architecture: 'swiftshader' }))).toBe(
      true,
    );
    expect(isSoftwareRenderer(webgpu({ vendor: 'nvidia', architecture: 'ada' }))).toBe(false);
  });
});
