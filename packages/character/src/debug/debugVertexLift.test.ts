// What can be checked about the debug lift without a GPU: the shipped WGSL string, the
// slot arithmetic, the params byte layout and the palettes.
//
// The point of the debug lift is that it writes the SAME buffers in the SAME layout as
// the real one, so the assertions below are mostly "this shader agrees with
// lift_pass2_cov.wgsl". A debug path that quietly wrote a different covariance order
// would still render something plausible — an ellipsoid is an ellipsoid — and would then
// have proved nothing about the path it was standing in for.

import { describe, expect, it } from 'vitest';

import {
  DEBUG_LIFT_PARAMS_BYTES,
  DEBUG_LIFT_WORKGROUP,
  debugLiftDispatch,
  fitVertsTransform,
  IDENTITY_3X4,
  writeDebugLiftParams,
} from './DebugVertexLift.js';
import { flatTint, heightTint, jointTint, packRgba, uvTint } from './vertexTint.js';
import { debugVertexLiftWgsl, liftPass2CovWgsl } from '../generated/index.js';
import type { AosRigPack } from '../rig/gnm/gnmPack.js';

describe('the debug lift shader', () => {
  it('declares a compute entry point', () => {
    expect(debugVertexLiftWgsl).toMatch(/@compute\s+@workgroup_size\(64\)\s*\r?\nfn main\(/);
  });

  it('binds the four sink buffers in group 1, exactly as the real lift does', () => {
    for (const source of [debugVertexLiftWgsl, liftPass2CovWgsl]) {
      expect(source).toMatch(
        /@group\(1\) @binding\(0\) var<storage, read_write> center:\s+array<vec4<f32>>/,
      );
      expect(source).toMatch(
        /@group\(1\) @binding\(1\) var<storage, read_write> covariance_a:\s+array<vec4<f32>>/,
      );
      expect(source).toMatch(
        /@group\(1\) @binding\(2\) var<storage, read_write> covariance_b:\s+array<vec4<f32>>/,
      );
      expect(source).toMatch(
        /@group\(1\) @binding\(3\) var<storage, read_write> color:\s+array<u32>/,
      );
    }
  });

  it('writes the covariance in writeCovariance order, split across two vec4', () => {
    expect(debugVertexLiftWgsl).toContain('vec4<f32>(c00, c01, c02, c11)');
    expect(debugVertexLiftWgsl).toContain('vec4<f32>(c12, c22, 0.0, 0.0)');
  });

  it('is isotropic: the diagonal is sigma squared and the off-diagonal is zero', () => {
    // An anisotropic debug gaussian would encode a rotation nothing computed, and a rig
    // bug would then be indistinguishable from a covariance bug.
    expect(debugVertexLiftWgsl).toContain('let s2 = params.sigma * params.sigma;');
    expect(debugVertexLiftWgsl).toMatch(/let c00 = s2;/);
    expect(debugVertexLiftWgsl).toMatch(/let c11 = s2;/);
    expect(debugVertexLiftWgsl).toMatch(/let c22 = s2;/);
    expect(debugVertexLiftWgsl).toMatch(/let c01 = 0\.0;/);
    expect(debugVertexLiftWgsl).toMatch(/let c02 = 0\.0;/);
    expect(debugVertexLiftWgsl).toMatch(/let c12 = 0\.0;/);
  });

  it('addresses a slot as `slot_offset + i` and packs the colour with pack4x8unorm', () => {
    expect(debugVertexLiftWgsl).toContain('params.slot_offset + s');
    expect(debugVertexLiftWgsl).toContain('pack4x8unorm');
  });

  it('CLEARS a slot past the vertex count rather than skipping it', () => {
    // An allocated-but-unwritten slot renders whatever the buffer held, which for a
    // freshly grown sink is the previous character.
    expect(debugVertexLiftWgsl).toContain(
      'if (s >= params.vertex_count) { write_empty(slot); return; }',
    );
  });

  it('drops a non-finite vertex instead of writing NaN into the sort', () => {
    expect(debugVertexLiftWgsl).toContain('fn is_finite(');
    expect(debugVertexLiftWgsl).toMatch(/is_finite\(p\.x\)/);
  });

  it('reads the rig buffer as f32 triples, the way every backend writes it', () => {
    expect(debugVertexLiftWgsl).toMatch(
      /@group\(0\) @binding\(0\) var<storage, read>\s+verts:\s+array<f32>/,
    );
    expect(debugVertexLiftWgsl).toContain('verts[b], verts[b + 1u], verts[b + 2u]');
  });
});

describe('the slot arithmetic', () => {
  it('dispatches enough workgroups to visit every slot', () => {
    expect(debugLiftDispatch(1)).toBe(1);
    expect(debugLiftDispatch(DEBUG_LIFT_WORKGROUP)).toBe(1);
    expect(debugLiftDispatch(DEBUG_LIFT_WORKGROUP + 1)).toBe(2);
    // The shipped head.
    expect(debugLiftDispatch(17_821)).toBe(279);
    expect(279 * DEBUG_LIFT_WORKGROUP).toBeGreaterThanOrEqual(17_821);
  });

  it('covers the whole RANGE, not just the vertices', () => {
    // The range may be longer than the rig (a sink sized for a whole character), and the
    // tail has to be cleared — so the dispatch is sized from the slot count.
    const slots = 20_000;
    expect(debugLiftDispatch(slots) * DEBUG_LIFT_WORKGROUP).toBeGreaterThanOrEqual(slots);
  });
});

describe('the params uniform', () => {
  const params = {
    vertexCount: 17_821,
    slotOffset: 4096,
    slotCount: 18_000,
    shading: 'normal' as const,
    transform: [2, 0, 0, 0.5, 0, 2, 0, -0.25, 0, 0, 2, 1],
    sigma: 0.002,
    opacity: 0.75,
    centroid: [0, 1, 2] as [number, number, number],
  };

  it('is 96 bytes: four u32, a 3x4 row-major affine, four f32 and a vec4', () => {
    expect(DEBUG_LIFT_PARAMS_BYTES).toBe(96);
    expect(writeDebugLiftParams(params).byteLength).toBe(96);
  });

  it('packs every field where the shader reads it', () => {
    const buffer = writeDebugLiftParams(params);
    const u32 = new Uint32Array(buffer);
    const f32 = new Float32Array(buffer);
    expect([...u32.subarray(0, 4)]).toEqual([17_821, 4096, 18_000, 1]);
    expect([...f32.subarray(4, 16)]).toEqual(params.transform);
    expect(f32[16]).toBeCloseTo(0.002, 9);
    expect(f32[17]).toBeCloseTo(0.75, 9);
    expect([...f32.subarray(20, 23)]).toEqual([0, 1, 2]);
  });

  it('encodes the shading mode as the number the shader switches on', () => {
    const code = (shading: 'tint' | 'normal' | 'flat'): number =>
      new Uint32Array(writeDebugLiftParams({ ...params, shading }))[3];
    expect(code('tint')).toBe(0);
    expect(code('normal')).toBe(1);
    expect(code('flat')).toBe(2);
    expect(debugVertexLiftWgsl).toContain('params.shading == 0u');
    expect(debugVertexLiftWgsl).toContain('params.shading == 1u');
  });

  it('refuses a transform that is not a row-major 3x4', () => {
    expect(() => writeDebugLiftParams({ ...params, transform: [1, 0, 0, 0] })).toThrow(
      /12 numbers/,
    );
  });

  it("reuses the caller's buffer, so the per-frame path allocates nothing", () => {
    const scratch = new ArrayBuffer(DEBUG_LIFT_PARAMS_BYTES);
    expect(writeDebugLiftParams(params, scratch)).toBe(scratch);
    expect(() => writeDebugLiftParams(params, new ArrayBuffer(64))).toThrow(/96 bytes/);
  });
});

describe('the placement fit', () => {
  // A head-shaped box in metres, off the origin exactly as GNM's is (y 0.04 .. 0.42).
  const aabb = { min: [-0.13, 0.045, -0.08] as const, max: [0.13, 0.418, 0.146] as const };

  it('centres the bounds on the origin and scales the longest axis to `height`', () => {
    const { transform, scale } = fitVertsTransform(aabb, { height: 0.35 });
    expect(scale).toBeCloseTo(0.35 / (0.418 - 0.045), 6);
    // The centre of the box maps to the origin.
    const apply = (p: readonly number[]): number[] =>
      [0, 1, 2].map(
        (r) =>
          transform[r * 4] * p[0] +
          transform[r * 4 + 1] * p[1] +
          transform[r * 4 + 2] * p[2] +
          transform[r * 4 + 3],
      );
    const mid = [0, (0.418 + 0.045) / 2, (0.146 - 0.08) / 2];
    for (const v of apply(mid)) expect(v).toBeCloseTo(0, 6);
  });

  it('honours an explicit scale and offset', () => {
    const { transform, scale } = fitVertsTransform(aabb, { scale: 1, offset: [0, 1, 0] });
    expect(scale).toBe(1);
    expect(transform[7]).toBeCloseTo(1 - (0.418 + 0.045) / 2, 6);
  });

  it('does not divide by zero on degenerate bounds', () => {
    const point = { min: [0, 0, 0] as const, max: [0, 0, 0] as const };
    expect(fitVertsTransform(point).scale).toBe(1);
    expect(fitVertsTransform(point).transform).toEqual([...IDENTITY_3X4]);
  });
});

describe('the vertex tints', () => {
  it('packs a colour the way unpack4x8unorm reads it', () => {
    expect(packRgba(1, 0, 0, 1)).toBe(0xff0000ff);
    expect(packRgba(0, 1, 0, 1)).toBe(0xff00ff00);
    expect(packRgba(0, 0, 1, 1)).toBe(0xffff0000);
    // Out of range clamps rather than wrapping into a different colour.
    expect(packRgba(2, -1, 0.5, 1)).toBe(packRgba(1, 0, 0.5, 1));
  });

  it('gives the eyes a colour of their own, so a lost eye weight is visible', () => {
    // Two vertices, one weighted to an eye joint and one not.
    const pack = {
      vertexCount: 2,
      maxInfluence: 2,
      skinIndex: Uint16Array.from([0, 1, 0, 1]),
      skinWeight: Float32Array.from([1, 0, 1, 0]),
      eyeWeights: Float32Array.from([0, 1, 0, 0]),
    } as unknown as AosRigPack;
    const tint = jointTint(pack);
    expect(tint[0]).not.toBe(tint[1]);
    expect(tint.length).toBe(2);
  });

  it('maps uv into red and green', () => {
    const tint = uvTint(Float32Array.from([0, 0, 1, 1]), 2);
    expect(tint[0] & 0xffff).toBe(packRgba(0, 0, 0.55) & 0xffff);
    expect(tint[1] & 0xff).toBe(255);
  });

  it('ramps by height and survives a flat mesh', () => {
    const ramp = heightTint(Float32Array.from([0, 0, 0, 0, 1, 0]), 2);
    expect(ramp[0]).not.toBe(ramp[1]);
    const flat = heightTint(Float32Array.from([0, 0, 0, 0, 0, 0]), 2);
    expect(flat[0]).toBe(flat[1]);
  });

  it('fills a flat tint opaquely', () => {
    const tint = flatTint(3, [1, 1, 1]);
    expect([...tint]).toEqual([0xffffffff, 0xffffffff, 0xffffffff]);
  });
});
