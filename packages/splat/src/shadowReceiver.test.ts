import { DepthTexture, Matrix4, Vector4 } from 'three/webgpu';
import { Fn, positionWorld } from 'three/tsl';
import { describe, expect, it } from 'vitest';

import {
  AnimatedGaussianSplat,
  createShadowReceiver,
  shadowFactorAt,
} from './three-fork/AnimatedGaussianSplat.js';

const params = { strength: 0.5, bias: 0.001, contactStrength: 0.4, contactCount: 1 };
const base = {
  map: new DepthTexture(4, 4),
  matrix: new Matrix4(),
  size: 4,
  taps: [0, 0, 1],
  params,
};

describe('fork edit 16: a splat that receives shadows', () => {
  it('rebuilds the shader without new storage and restores it with null', () => {
    const splat = new AnimatedGaussianSplat({ capacity: 4 });
    const original = splat.material.vertexNode;
    const storage = [...splat.storageAttributes()];
    splat.setShadowReceiver(base);
    expect(splat.material.vertexNode).not.toBe(original);
    expect([...splat.storageAttributes()]).toEqual(storage);
    expect(splat.material.depthWrite).toBe(false);
    splat.setShadowReceiver(null);
    expect([...splat.storageAttributes()]).toEqual(storage);
    splat.dispose();
  });

  it('keeps edit 13 lighting and edit 15 fading through its rebuild', () => {
    const splat = new AnimatedGaussianSplat({ capacity: 4 });
    splat.setEnvironmentLighting({
      radianceSH: [
        [3.5449, 3.5449, 3.5449],
        ...Array.from({ length: 8 }, () => [0, 0, 0] as const),
      ],
    });
    const fade = (): never => undefined as never;
    splat.setFragmentAlpha(fade);
    splat.setShadowReceiver(base);
    const buffers = (splat as unknown as { _buffers: Record<string, unknown> })._buffers;
    expect(buffers.environmentLighting).not.toBeNull();
    expect(buffers.fragmentAlpha).toBe(fade);
    expect(buffers.shadowReceiver).not.toBeNull();
    splat.dispose();
  });

  it('takes a contact shadow alone, with no depth map', () => {
    const splat = new AnimatedGaussianSplat({ capacity: 4 });
    expect(() => {
      splat.setShadowReceiver({ map: null, params, contacts: [new Vector4(0, 0, 0, 1)] });
    }).not.toThrow();
    splat.dispose();
  });

  it('rejects options that cannot draw', () => {
    const splat = new AnimatedGaussianSplat({ capacity: 4 });
    // Not a depth texture, no taps, too many contacts, nothing at all.
    expect(() => {
      splat.setShadowReceiver({ ...base, map: {} as DepthTexture });
    }).toThrow(TypeError);
    expect(() => {
      splat.setShadowReceiver({ ...base, taps: [0, 0] });
    }).toThrow(RangeError);
    expect(() => {
      splat.setShadowReceiver({
        ...base,
        contacts: Array.from({ length: 17 }, () => new Vector4()),
      });
    }).toThrow(RangeError);
    expect(() => {
      splat.setShadowReceiver({ map: null, params });
    }).toThrow(RangeError);
    splat.dispose();
  });

  it('shares its uniforms with a mesh: the same factor node builds from a world position', () => {
    const receiver = createShadowReceiver({ ...base, contacts: [new Vector4(0, 0, 0, 1)] });
    expect(receiver.map).toBe(base.map);
    // Inside a shader function, as a material's node is built.
    expect(Fn(() => shadowFactorAt(positionWorld, receiver))()).toBeDefined();
  });
});
