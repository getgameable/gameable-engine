// The lift's out-of-ONNX maths: the plücker rays, the scale map, the triangle clamp,
// the validity fold, the vert-transform packing and the slot allocator.
//
// Every one of these is applied AFTER the decoder, so the exported ONNX graph does not
// carry it and no amount of decoder verification can see it. A bundle that omits one,
// or a lift that ignores one, renders a DIFFERENT MODEL and reports nothing — which is
// why they are all pure modules with their own tests rather than lines inside a shader.

import { PerspectiveCamera, Quaternion } from 'three/webgpu';
import { describe, expect, it } from 'vitest';

import { validityMaskedTriim } from './inference/liftTriim.js';
import {
  logSigmoid,
  scaleMapConstants,
  splatScale,
  type SplatScaleMap,
} from './inference/splatScale.js';
import {
  EQUILATERAL_SQRT_AREA_PER_EDGE,
  SLIVER_DERATE_RATIO,
  triangleBound,
  triangleEdgeArea,
  triangleQuality,
  triScaleGain,
} from './inference/triBound.js';
import {
  computePluckerRays,
  toLocalOrigin,
  toLocalRotation,
  type PluckerCamera,
} from './inference/plucker.js';
import { LocalFrameCamera } from './render/localFrameCamera.js';
import {
  packVertTransformParams,
  VERT_TRANSFORM_PARAMS_BYTES,
} from './inference/vertTransformParams.js';
import { imageDataToOpacityMask } from './inference/opacityMask.js';
import { sampleMaskBilinear } from './types.js';
import { SlotAllocator } from './render/slotAllocator.js';
import { worldRotationQuaternion, quaternionToWxyz } from './render/worldRotation.js';

function camera(position: [number, number, number], fov = 50, aspect = 1): PerspectiveCamera {
  const c = new PerspectiveCamera(fov, aspect, 0.1, 100);
  c.position.set(...position);
  c.updateMatrixWorld(true);
  return c;
}

/**
 * A scene camera as the `PluckerCamera` the ray builders take.
 *
 * The interface asks for `getFramePosition`, not `getWorldPosition`, deliberately: a
 * raw scene camera used to satisfy it structurally, which is exactly how the world
 * camera reached the plücker path in the first place. Against a null root a
 * `LocalFrameCamera` is the identity, so these rays are the same numbers the old
 * tests measured.
 *
 * @param position Camera world position.
 * @param fov Vertical field of view in degrees.
 * @param aspect Viewport aspect ratio.
 * @returns The camera in the avatar frame — here, the world frame.
 */
function frameCamera(position: [number, number, number], fov = 50, aspect = 1): PluckerCamera {
  return new LocalFrameCamera().update(camera(position, fov, aspect), null);
}

describe('plücker rays', () => {
  const W = 4;
  const H = 4;
  const stride = W * H;

  it('emits channel-major (6, H, W): moment.xyz then dir.xyz', () => {
    const rays = computePluckerRays(frameCamera([0, 0, 2]), W, H);
    expect(rays.length).toBe(6 * stride);
    // Direction-only by default, so the moment channels are zero (signed, since the
    // cross product can produce -0).
    for (let i = 0; i < 3 * stride; i++) expect(Math.abs(rays[i])).toBe(0);
    // Every direction is a unit vector.
    for (let p = 0; p < stride; p++) {
      const d = Math.hypot(rays[3 * stride + p], rays[4 * stride + p], rays[5 * stride + p]);
      expect(d).toBeCloseTo(1, 6);
    }
  });

  it('points an untransformed camera down -Z', () => {
    // three's camera looks down its own -Z; the rays must agree, or the appearance
    // decoder is conditioned on a viewer facing the back of the head. Averaged over the
    // grid the mean is not exactly -1 — every ray but the centre one tilts by half the
    // fov — so the assertion is on the SIGN and the dominant axis.
    const rays = computePluckerRays(frameCamera([0, 0, 2]), 2, 2);
    const s = 4;
    let dx = 0;
    let dy = 0;
    let dz = 0;
    for (let p = 0; p < s; p++) {
      dx += rays[3 * s + p];
      dy += rays[4 * s + p];
      dz += rays[5 * s + p];
    }
    expect(dx / s).toBeCloseTo(0, 6);
    expect(dy / s).toBeCloseTo(0, 6);
    expect(dz / s).toBeLessThan(-0.9);
  });

  it('flips Y so the top row is +1', () => {
    // `ny = 1 - 2(y+0.5)/H`: row 0 must look UP. Getting this backwards renders the
    // view-dependent shading upside down, which looks like a lighting choice.
    const rays = computePluckerRays(frameCamera([0, 0, 2]), 1, 2);
    expect(rays[4 * 2 + 0]).toBeGreaterThan(0); // row 0
    expect(rays[4 * 2 + 1]).toBeLessThan(0); // row 1
  });

  it('scales only the MOMENT channels by momentScale', () => {
    // dir is invariant to translation and to scale; the moment (origin × dir) is
    // neither. Direction-only is the default because the moment encodes absolute camera
    // position, which appr can overfit to the capture rig.
    const off = computePluckerRays(frameCamera([1, 2, 3]), W, H, { momentScale: 0 });
    const on = computePluckerRays(frameCamera([1, 2, 3]), W, H, { momentScale: 1 });
    for (let i = 0; i < 3 * stride; i++) expect(Math.abs(off[i])).toBe(0);
    let anyMoment = false;
    for (let i = 0; i < 3 * stride; i++) if (on[i] !== 0) anyMoment = true;
    expect(anyMoment).toBe(true);
    // The direction half is untouched by the moment scale.
    for (let i = 3 * stride; i < 6 * stride; i++) expect(on[i]).toBeCloseTo(off[i], 12);
  });

  it('subtracts worldOffset BEFORE applying originScale', () => {
    // `(world - offset) * scale` is not `world * scale - offset`; on a cm bundle those
    // differ by a factor of 100. Only the moment can see it, which is why the defect
    // stayed invisible until a bundle shipped a world_offset WITH moment_scale 1.
    const withOffset = computePluckerRays(frameCamera([0, 1.55, 2]), W, H, {
      momentScale: 1,
      worldOffset: [0, 1.55, 0],
      originScale: 100,
    });
    const atOrigin = computePluckerRays(frameCamera([0, 0, 2]), W, H, {
      momentScale: 1,
      originScale: 100,
    });
    for (let i = 0; i < 3 * stride; i++) expect(withOffset[i]).toBeCloseTo(atOrigin[i], 4);
  });

  it('moves the camera into the splat frame, origin then orientation', () => {
    // Subtract THEN scale, and rotate about the splat's own origin AFTER the
    // subtraction: both halves live in one call so neither path can apply one without
    // the other.
    expect(toLocalOrigin({ x: 1, y: 2, z: 3 }, [1, 1, 1])).toEqual({ x: 0, y: 1, z: 2 });
    expect(toLocalOrigin({ x: 1, y: 2, z: 3 })).toEqual({ x: 1, y: 2, z: 3 });

    // A null rotation leaves the pose byte-identical, so an unrotated bundle takes the
    // same path it took before world_rotation existed.
    const position = camera([1, 2, 3]).position;
    const q = new Quaternion(0.1, 0.2, 0.3, 0.9).normalize();
    const before = q.clone();
    toLocalRotation(position, q, null);
    expect(q.equals(before)).toBe(true);
    expect([position.x, position.y, position.z]).toEqual([1, 2, 3]);

    // A real rotation moves BOTH: rotating the mesh without the camera leaves the
    // view-dependent shading reading from a viewpoint that does not exist.
    const half = worldRotationQuaternion([0, 0, 180])!;
    toLocalRotation(position, q, half);
    expect(position.x).toBeCloseTo(-1, 6);
    expect(position.y).toBeCloseTo(-2, 6);
    expect(position.z).toBeCloseTo(3, 6);
    expect(q.equals(before)).toBe(false);
  });

  it('turns the bundle rotation into a quaternion, and null when there is nothing to undo', () => {
    // Null rather than an identity quaternion so an unrotated bundle takes byte-
    // identical paths to the ones it took before this existed.
    expect(worldRotationQuaternion([0, 0, 0])).toBeNull();
    expect(worldRotationQuaternion(undefined)).toBeNull();
    expect(worldRotationQuaternion([0, 0, Number.NaN])).toBeNull();
    const q = worldRotationQuaternion([0, 0, 180]);
    expect(q).not.toBeNull();
    expect(quaternionToWxyz(q)).toHaveLength(4);
    expect(quaternionToWxyz(null)).toEqual([1, 0, 0, 0]);
    // 180° about Z: (w, x, y, z) = (0, 0, 0, 1) up to sign.
    const [w, , , z] = quaternionToWxyz(q);
    expect(Math.abs(w)).toBeCloseTo(0, 6);
    expect(Math.abs(z)).toBeCloseTo(1, 6);
  });
});

describe('the trainer scale map', () => {
  it('is stable in both tails', () => {
    // `Math.log(1/(1+Math.exp(-x)))` underflows to -Infinity below about x = -745.
    expect(logSigmoid(0)).toBeCloseTo(Math.log(0.5), 12);
    expect(logSigmoid(-800)).toBeCloseTo(-800, 6);
    expect(Number.isFinite(logSigmoid(-800))).toBe(true);
    expect(logSigmoid(800)).toBeCloseTo(0, 12);
  });

  it('uses the ADDITIVE map when sigmaMax is 0', () => {
    const map: SplatScaleMap = {
      sigmaMax: 0,
      sigmaOffset: 99,
      scaleLogBias: 0.5,
      scaleLogMax: Infinity,
    };
    const c = scaleMapConstants(map);
    expect(c.bounded).toBe(0);
    // sigmaOffset is MEANINGLESS here; reading it would apply a wild bias.
    expect(c.offset).toBe(0.5);
    expect(splatScale(1, c)).toBeCloseTo(Math.exp(1.5), 12);
  });

  it('uses the BOUNDED map when sigmaMax is set, and does NOT add the bias twice', () => {
    // Under the bounded map the bias is folded into sigmaOffset — the trainer solves
    // `sigmoid(offset) = exp(bias)/sigmaMax` so the map is the identity at init — and
    // adding the bias again applies it twice.
    const map: SplatScaleMap = {
      sigmaMax: 2,
      sigmaOffset: -0.5,
      scaleLogBias: 0.5,
      scaleLogMax: Infinity,
    };
    const c = scaleMapConstants(map);
    expect(c.bounded).toBe(1);
    expect(c.offset).toBe(-0.5);
    expect(c.logSigmaMax).toBeCloseTo(Math.log(2), 12);
    expect(splatScale(0, c)).toBeCloseTo(2 * (1 / (1 + Math.exp(0.5))), 10);
  });

  it('agrees EXACTLY with the additive map at raw = 0 when the offset is solved', () => {
    // That identity-at-init property is why ignoring the bound is so hard to spot: the
    // neutral render looks correct and only the splats above the initial scale inflate.
    const sigmaMax = 9.4;
    const bias = -1.2;
    const sigmaOffset = -Math.log(sigmaMax / Math.exp(bias) - 1);
    const bounded = scaleMapConstants({
      sigmaMax,
      sigmaOffset,
      scaleLogBias: 0,
      scaleLogMax: Infinity,
    });
    const additive = scaleMapConstants({
      sigmaMax: 0,
      sigmaOffset: 0,
      scaleLogBias: bias,
      scaleLogMax: Infinity,
    });
    expect(splatScale(0, bounded)).toBeCloseTo(splatScale(0, additive), 9);
    // And diverges above it, which is the oversized-splat artefact.
    expect(splatScale(3, bounded)).toBeLessThan(splatScale(3, additive));
  });

  it('applies the ceiling AFTER the bias, not before', () => {
    // Clamping first would cap a different quantity and let e^bias through on top of it.
    const c = scaleMapConstants({ sigmaMax: 0, sigmaOffset: 0, scaleLogBias: 2, scaleLogMax: 1 });
    expect(splatScale(5, c)).toBeCloseTo(Math.E, 12);
  });
});

describe('the triangle-bounded clamp', () => {
  it('scores an equilateral face at 1', () => {
    const L = 1;
    const area = (Math.sqrt(3) / 4) * L * L;
    expect(triangleQuality(L, area)).toBeCloseTo(1, 9);
    expect(EQUILATERAL_SQRT_AREA_PER_EDGE).toBeCloseTo(Math.pow(3, 0.25) / 2, 15);
  });

  it('scores a sliver near 0, scale-invariantly', () => {
    // One threshold must mean the same thing on a 2 mm head face and a 9 mm garment one.
    const thin = triangleEdgeArea(1, 0, 0, 0.5, 1e-4, 0);
    const scaled = triangleEdgeArea(100, 0, 0, 50, 1e-2, 0);
    expect(triangleQuality(thin.edge, thin.area)).toBeLessThan(0.02);
    expect(triangleQuality(thin.edge, thin.area)).toBeCloseTo(
      triangleQuality(scaled.edge, scaled.area),
      6,
    );
  });

  it('reads the host triangle out of the Jacobian columns', () => {
    // Columns 0 and 1 ARE the edge vectors, so neither lifter needs extra data. Column 2
    // is the normal and is NOT unit length, which is why the area comes from
    // cross(e0, e1) and not from that column.
    const { edge, area } = triangleEdgeArea(3, 0, 0, 0, 4, 0);
    expect(edge).toBe(5); // the hypotenuse
    expect(area).toBe(6);
  });

  it('is INERT with the clamp off', () => {
    // `qMin <= 0` returns the longest edge exactly, and `kappa <= 0` returns a gain of
    // exactly 1 — so enabling the module cannot perturb a pre-clamp bundle.
    expect(triangleBound(5, 6, 0)).toBe(5);
    expect(triangleBound(5, 6, -1)).toBe(5);
    expect(triScaleGain(1e6, 1, 0)).toBe(1);
  });

  it('derates linearly over [qMin, 5·qMin] and is exactly 1 above the band', () => {
    expect(SLIVER_DERATE_RATIO).toBe(5);
    const L = 1;
    const area = (Math.sqrt(3) / 4) * L * L; // quality 1
    expect(triangleBound(L, area, 0.1)).toBe(L); // q=1 > 5*0.1, so no derate
    // Inside the band the bound is derated by q / (5·qMin).
    const q = triangleQuality(L, area);
    expect(triangleBound(L, area, 0.5)).toBeCloseTo(L * Math.min(1, q / 2.5), 9);
  });

  it('returns EXACTLY 1 for a compliant splat', () => {
    // Not approximately: enabling the clamp must not perturb geometry that already
    // satisfies it.
    expect(triScaleGain(0.5, 1, 1)).toBe(1);
    expect(triScaleGain(2, 1, 1)).toBeCloseTo(0.5, 12);
  });
});

describe('the validity fold', () => {
  it('turns an invalid texel into face -1', () => {
    // `lift_pass1.wgsl` reads validity out of `triim`, which is what holds it to 8
    // storage buffers — one more than that is past WebGPU's default limit and refuses a
    // stock adapter the GPU lift entirely.
    const triim = Int32Array.from([0, 7, 12, 3]);
    const valid = Uint8Array.from([1, 0, 1, 0]);
    expect([...validityMaskedTriim(triim, valid)]).toEqual([0, -1, 12, -1]);
  });
});

describe('the vert-transform uniform', () => {
  it('packs the 3x3 as ROWS, padded to vec4, with the counts in the tail', () => {
    // Rows, not columns: the transform is applied as the row-vector product `v·M`,
    // matching the offline `v @ lin`. Getting it backwards transposes a small rotation,
    // which looks like a slightly poor fit rather than like a bug.
    const lin = [1, 2, 3, 4, 5, 6, 7, 8, 9];
    const buffer = packVertTransformParams(lin, [10, 11, 12], 24049, true);
    expect(buffer.byteLength).toBe(VERT_TRANSFORM_PARAMS_BYTES);
    const f = new Float32Array(buffer);
    const u = new Uint32Array(buffer);
    expect([f[0], f[1], f[2]]).toEqual([1, 2, 3]);
    expect([f[4], f[5], f[6]]).toEqual([4, 5, 6]);
    expect([f[8], f[9], f[10]]).toEqual([7, 8, 9]);
    expect([f[12], f[13], f[14]]).toEqual([10, 11, 12]);
    expect(u[16]).toBe(24049);
    expect(u[17]).toBe(1);
    expect(new Float32Array(packVertTransformParams(lin, [0, 0, 0], 1, false))[0]).toBe(1);
    expect(new Uint32Array(packVertTransformParams(lin, [0, 0, 0], 1, false))[17]).toBe(0);
  });
});

describe('the opacity mask', () => {
  it('reads Rec.709 luma by default and never reads past the buffer', () => {
    const mask = imageDataToOpacityMask({
      data: [255, 255, 255, 255, 0, 0, 0, 255],
      width: 2,
      height: 1,
    });
    expect(mask.data[0]).toBeCloseTo(1, 6);
    expect(mask.data[1]).toBe(0);
    // A malformed mask is a loud failure, never a silently truncated cutout.
    expect(() => imageDataToOpacityMask({ data: [1, 2, 3], width: 2, height: 1 })).toThrow(
      /expected RGBA8/,
    );
    expect(() => imageDataToOpacityMask({ data: [], width: 0, height: 0 })).toThrow(/bad size/);
  });

  it('inverts and reads a single channel on request', () => {
    const alpha = imageDataToOpacityMask(
      { data: [0, 0, 0, 128], width: 1, height: 1 },
      { channel: 'a' },
    );
    expect(alpha.data[0]).toBeCloseTo(128 / 255, 6);
    const inverted = imageDataToOpacityMask(
      { data: [255, 255, 255, 255], width: 1, height: 1 },
      { invert: true },
    );
    expect(inverted.data[0]).toBeCloseTo(0, 6);
  });

  it('samples bilinearly and clamps to the edge', () => {
    // The CPU reference the shader's `sample_mask` is a direct port of, so the cull is
    // identical on both sides.
    const mask = { data: Float32Array.from([0, 1, 0, 1]), width: 2, height: 2 };
    expect(sampleMaskBilinear(mask, 0, 0)).toBe(0);
    expect(sampleMaskBilinear(mask, 1, 0)).toBe(1);
    expect(sampleMaskBilinear(mask, 0.5, 0)).toBeCloseTo(0.5, 6);
    expect(sampleMaskBilinear(mask, -5, 9)).toBe(0);
    expect(sampleMaskBilinear({ data: new Float32Array(0), width: 0, height: 0 }, 0, 0)).toBe(1);
  });
});

describe('the slot allocator', () => {
  it('hands out contiguous, deterministic ranges', () => {
    // Deterministic so a test can assert exact offsets, and contiguous because the lift
    // addresses a branch as `slot_offset + texel`.
    const allocator = new SlotAllocator(1000);
    expect(allocator.allocate(256)).toEqual({ offset: 0, count: 256 });
    expect(allocator.allocate(100)).toEqual({ offset: 256, count: 100 });
    expect(allocator.available).toBe(644);
  });

  it('coalesces on free, so a reload reuses the same offsets', () => {
    const allocator = new SlotAllocator(1000);
    const a = allocator.allocate(256);
    const b = allocator.allocate(256);
    allocator.free(a);
    allocator.free(b);
    expect(allocator.blocks()).toEqual([{ offset: 0, count: 1000 }]);
    expect(allocator.allocate(512)).toEqual({ offset: 0, count: 512 });
  });

  it('first-fits into a hole rather than always appending', () => {
    const allocator = new SlotAllocator(1000);
    const a = allocator.allocate(100);
    allocator.allocate(100);
    allocator.free(a);
    expect(allocator.allocate(50)).toEqual({ offset: 0, count: 50 });
  });

  it('THROWS when it cannot place a branch', () => {
    // A null would surface as a character missing one region with no error anywhere.
    const allocator = new SlotAllocator(100);
    allocator.allocate(60);
    expect(() => allocator.allocate(60)).toThrow(/no contiguous run/);
    expect(() => allocator.allocate(0)).toThrow(/positive integer/);
  });

  it('refuses a double free', () => {
    // Two owners believing they hold the same slots renders one branch's gaussians at
    // another's pose.
    const allocator = new SlotAllocator(100);
    const range = allocator.allocate(10);
    allocator.free(range);
    expect(() => {
      allocator.free(range);
    }).toThrow(/already free/);
    expect(() => {
      allocator.free({ offset: 95, count: 10 });
    }).toThrow(/past capacity/);
  });
});
