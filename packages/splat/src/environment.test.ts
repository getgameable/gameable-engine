import { expect, it, vi } from 'vitest';
import { Scene, Texture, type Renderer } from 'three/webgpu';
const state = vi.hoisted(() => ({
  disposeGenerator: vi.fn(),
  disposeTarget: vi.fn(),
  filter: vi.fn(),
}));
vi.mock('three/webgpu', async (importOriginal) => ({
  ...(await importOriginal<typeof import('three/webgpu')>()),
  PMREMGenerator: class {
    fromEquirectangular = state.filter;
    dispose = state.disposeGenerator;
  },
}));
import { createEnvironmentProbe } from './environment';
it('shares probe brightness and restores caller state without disposing caller textures', () => {
  const scene = new Scene(),
    previous = new Texture(),
    texture = new Texture(),
    filtered = new Texture();
  const disposeInput = vi.spyOn(texture, 'dispose');
  scene.environment = previous;
  scene.environmentIntensity = 2;
  scene.environmentRotation.y = 0.4;
  state.filter.mockReturnValue({ texture: filtered, dispose: state.disposeTarget });
  const sh = Array.from({ length: 9 }, () => [1, 2, 3] as const);
  const lighting = createEnvironmentProbe(scene, {} as Renderer, texture, {
    radianceSH: sh,
    intensity: 0.5,
    yaw: 1,
  });
  expect(scene.environment).toBe(filtered);
  expect(scene.environmentIntensity).toBe(0.5);
  expect(lighting.radianceSH[0]).toEqual([0.5, 1, 1.5]);
  expect(sh[0]).toEqual([1, 2, 3]);
  lighting.dispose();
  lighting.dispose();
  expect(scene.environment).toBe(previous);
  expect(scene.environmentRotation.y).toBe(0.4);
  expect(scene.environmentIntensity).toBe(2);
  expect(state.disposeTarget).toHaveBeenCalledTimes(1);
  expect(disposeInput).not.toHaveBeenCalled();
});
it('validates probes before allocating or mutating the scene', () => {
  const scene = new Scene();
  expect(() =>
    createEnvironmentProbe(scene, {} as Renderer, new Texture(), { radianceSH: [] }),
  ).toThrow(RangeError);
  expect(scene.environment).toBeNull();
});
