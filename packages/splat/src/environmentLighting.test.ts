import { Group, PointLight, Vector3 } from 'three/webgpu';
import { describe, expect, it } from 'vitest';
import { AnimatedGaussianSplat } from './three-fork/AnimatedGaussianSplat.js';
import type { SplatEnvironmentLighting } from './three-fork/AnimatedGaussianSplat.js';

const white: SplatEnvironmentLighting = {
  radianceSH: [
    [3.544908, 3.544908, 3.544908],
    ...Array.from({ length: 8 }, () => [0, 0, 0] as const),
  ],
};
describe('optional Gaussian environment lighting', () => {
  it('replaces the shader without adding storage or changing Gaussian coverage and restores it', () => {
    const splat = new AnimatedGaussianSplat({ capacity: 4 });
    const original = splat.material.vertexNode;
    const storage = [...splat.storageAttributes()];
    splat.setEnvironmentLighting(white);
    expect(splat.material.vertexNode).not.toBe(original);
    expect([...splat.storageAttributes()]).toEqual(storage);
    expect(splat.material.transparent).toBe(true);
    expect(splat.material.depthWrite).toBe(false);
    const lit = splat.material.vertexNode;
    splat.setEnvironmentLighting(null);
    expect(splat.material.vertexNode).not.toBe(lit);
    expect([...splat.storageAttributes()]).toEqual(storage);
    splat.dispose();
  });
  it('keeps live point light updates independent of material rebuilds and storage', () => {
    const splat = new AnimatedGaussianSplat({ capacity: 4 });
    const light = new PointLight(0xffbd78, 2.6, 3.4);
    const storage = [...splat.storageAttributes()];
    splat.setEnvironmentLighting({ ...white, pointLights: [light], twoSided: true });
    const shader = splat.material.vertexNode;
    // Exercise the render callbacks without needing a GPU. These are the actual uniforms
    // captured by the material graph, not a second lighting implementation.
    type LiveUniform<T> = { value: T; update(frame: object): void };
    const state = (
      splat as unknown as {
        _buffers: {
          environmentLighting: {
            pointLights: {
              position: LiveUniform<Vector3>;
              color: LiveUniform<Vector3>;
              distance: LiveUniform<number>;
              decay: LiveUniform<number>;
            }[];
          };
        };
      }
    )._buffers.environmentLighting.pointLights[0];
    const group = new Group();
    group.position.x = 5;
    group.add(light);
    const positionValue = state.position.value;
    const colorValue = state.color.value;
    light.position.set(2, 3, 4);
    light.intensity = 0.5;
    light.distance = 7;
    light.decay = 1;
    state.position.update({});
    state.color.update({});
    state.distance.update({});
    state.decay.update({});
    expect(state.position.value.toArray()).toEqual([7, 3, 4]);
    expect(state.color.value.x).toBeCloseTo(light.color.r * 0.5);
    expect(state.distance.value).toBe(7);
    expect(state.decay.value).toBe(1);
    light.visible = false;
    state.color.update({});
    expect(state.color.value.toArray()).toEqual([0, 0, 0]);
    expect(state.color.value).toBe(colorValue);
    expect(state.position.value).toBe(positionValue);
    expect(splat.material.vertexNode).toBe(shader);
    expect([...splat.storageAttributes()]).toEqual(storage);
    splat.setEnvironmentLighting(null);
    expect(splat.material.vertexNode).not.toBe(shader);
    splat.dispose();
    light.dispose();
  });
  it('rejects malformed probes and weights before changing a working shader', () => {
    const splat = new AnimatedGaussianSplat({ capacity: 4 });
    for (const invalid of [
      { radianceSH: [] },
      { ...white, radianceSH: [[NaN, 0, 0], ...white.radianceSH.slice(1)] },
      { ...white, emissionWeight: -1 },
      { ...white, diffuseWeight: Infinity },
      { ...white, normalOrigin: [0, NaN, 0] },
      { ...white, inputColorSpace: 'unknown' },
      { ...white, pointLights: [{}] },
      { ...white, pointLights: Array.from({ length: 17 }, () => new PointLight()) },
      { ...white, twoSided: 'yes' },
      { ...white, pointLightSoftness: 0 },
      { ...white, pointLightSoftness: NaN },
    ]) {
      const original = splat.material.vertexNode;
      expect(() => {
        splat.setEnvironmentLighting(invalid as SplatEnvironmentLighting);
      }).toThrow(RangeError);
      expect(splat.material.vertexNode).toBe(original);
    }
    splat.dispose();
  });
});
