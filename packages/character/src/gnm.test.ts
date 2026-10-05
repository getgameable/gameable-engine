// The GNM head: the `.aosrig` container, the TypeScript reference, and what the fp16
// basis quantisation costs.
//
// THE GATE CHAIN. `wgsl/gnm_blend.wgsl` is written against `gnmReference.ts`; this
// holds `gnmReference.ts` to `tools/gnm_reference.py`. Nothing here touches a GPU, so
// it runs on every push — which is the whole point: the shader half cannot be tested
// in node, so the arithmetic it mirrors has to be.
//
// THE FIXTURES are a 200-vertex STRIDED subset of the shipped myra head (17,821 verts),
// because the full pack is 42 MB and the full reference 2 MB. Strided, not a prefix:
// the first 200 vertices carry no eye weights at all — the eyeballs start around index
// 12,466 — so a prefix fixture would leave the gaze half of the model completely
// untested while looking like a full pass.
//
//   test/fixtures/gnm/myra-200.aosrig       tools/gnm_pack.py --subset 200
//   test/fixtures/gnm/reference_frames.npz  tools/gnm_reference.py --subset 200
//
// Both derive from F:/work/aos/aosRig/assets/myra/{myra.head.npz, myra.aosrig.*}.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import {
  floatToHalf,
  halfToFloat,
  headExtNames,
  packAosRig,
  parseAosRig,
  regionSlices,
  unpackHeadExt,
  type AosRigBlob,
  type AosRigHeader,
} from './rig/gnm/gnmPack.js';
import { basisLane, gazeToEyeRotations, gnmForward, gnmPose } from './rig/gnm/gnmReference.js';
import { readNpz, npzText } from './testing/npz.js';

const packBytes = new Uint8Array(
  readFileSync(new URL('../test/fixtures/gnm/myra-200.aosrig', import.meta.url)),
);
const referenceBytes = new Uint8Array(
  readFileSync(new URL('../test/fixtures/gnm/reference_frames.npz', import.meta.url)),
);

describe('.aosrig container', () => {
  it('parses the baked myra subset', () => {
    const pack = parseAosRig(packBytes);
    expect(pack.header.model).toBe('gnm');
    expect(pack.header.version).toBe(1);
    expect(pack.header.units).toBe('m');
    expect(pack.vertexCount).toBe(200);
    expect(pack.coeffCount).toBe(383);
    expect(pack.maxInfluence).toBe(4);
    expect(pack.neutral.length).toBe(200 * 3);
    expect(pack.basisScale.length).toBe(383);
    expect(pack.eyePositions.length).toBe(6);
    expect(pack.eyeWeights.length).toBe(2 * 200);
    expect(pack.stitchLocal?.length).toBe(200 * 3);
  });

  it('carries the head_ext layout the animation layer needs', () => {
    const layout = parseAosRig(packBytes).header.headExt;
    expect(layout.dim).toBe(387);
    expect(layout.exprDim).toBe(383);
    expect(layout.gazeDim).toBe(4);
    expect(layout.regions).toEqual([
      ['left_eye', 100],
      ['right_eye', 100],
      ['lower_face', 150],
      ['tongue', 32],
      ['pupils', 1],
    ]);
    // The reduced ML view: 64 expression + 4 gaze = 68.
    const reduced = Object.values(layout.reduced).reduce((a, b) => a + b, 0);
    expect(reduced + layout.gazeDim).toBe(68);

    const slices = regionSlices(layout);
    expect(slices.lower_face).toEqual({ start: 200, end: 350 });
    const names = headExtNames(layout);
    expect(names.length).toBe(387);
    expect(names[0]).toBe('left_eye_000');
    expect(names.slice(-4)).toEqual(['gaze_pitch_l', 'gaze_yaw_l', 'gaze_pitch_r', 'gaze_yaw_r']);
  });

  it('remaps the skinning onto a COMPACT joint list', () => {
    // The head references a handful of the body rig's 54 joints; shipping all 54 would
    // spend most of the skin-rows uniform on joints no vertex is weighted to.
    const pack = parseAosRig(packBytes);
    const joints = pack.header.joints;
    // The body rig has 54; the head reaches a handful plus their ancestors (the walk
    // that turns locals into worlds needs the chain, so a gap in it is not expressible).
    expect(joints.length).toBeLessThan(20);
    expect(joints.map((j) => j.name)).toContain('head');
    expect(joints.map((j) => j.name)).toContain('neck_01');
    // Every skin index addresses the compact list.
    for (const index of pack.skinIndex) expect(index).toBeLessThan(joints.length);
    // Every joint's parent is either a root or EARLIER in the list, so the forward walk
    // reads a parent before it writes a child.
    pack.jointParents.forEach((parent, j) => {
      expect(parent).toBeLessThan(j);
    });
    expect(pack.restWorld.length).toBe(joints.length * 16);
    expect(pack.bindTransform.length).toBe(16);
  });

  it('round-trips a synthetic pack byte for byte', () => {
    const header: Omit<AosRigHeader, 'buffers'> = {
      version: 1,
      model: 'gnm',
      vertexCount: 2,
      coeffCount: 2,
      maxInfluence: 4,
      units: 'm',
      headExt: {
        dim: 6,
        exprDim: 2,
        gazeDim: 4,
        regions: [['lower_face', 2]],
        reduced: { lower_face: 1 },
      },
      joints: [{ name: 'head', parent: -1 }],
      eyes: { names: ['left_eye', 'right_eye'] },
      bindTransform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
    };
    const neutral = Float32Array.from([0, 0, 0, 1, 2, 3]);
    // Vertex-major (V,E,3) fp16 lanes, two to a word.
    const lanes = new Uint16Array(2 * 2 * 3);
    for (let i = 0; i < lanes.length; i++) lanes[i] = floatToHalf((i + 1) * 0.25);
    const blobs: AosRigBlob[] = [
      { name: 'neutral', dtype: 'f32', shape: [2, 3], data: neutral },
      {
        name: 'basis',
        dtype: 'u32',
        shape: [lanes.length / 2],
        data: new Uint32Array(lanes.buffer),
      },
      { name: 'basisScale', dtype: 'f32', shape: [2], data: Float32Array.from([1, 1]) },
      { name: 'skinIndex', dtype: 'u16', shape: [2, 4], data: new Uint16Array(8) },
      {
        name: 'skinWeight',
        dtype: 'f16',
        shape: [2, 4],
        data: Uint16Array.from([floatToHalf(1), 0, 0, 0, floatToHalf(1), 0, 0, 0]),
      },
      { name: 'eyePositions', dtype: 'f32', shape: [2, 3], data: new Float32Array(6) },
      { name: 'eyeWeights', dtype: 'f32', shape: [2, 2], data: new Float32Array(4) },
      {
        name: 'restWorld',
        dtype: 'f32',
        shape: [1, 4, 4],
        data: Float32Array.from([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]),
      },
      { name: 'jointParents', dtype: 'i32', shape: [1], data: Int32Array.from([-1]) },
      { name: 'faces', dtype: 'u32', shape: [0, 3], data: new Uint32Array(0) },
    ];
    const packed = packAosRig(header, blobs);
    const parsed = parseAosRig(packed);
    expect(parsed.vertexCount).toBe(2);
    expect([...parsed.neutral]).toEqual([...neutral]);
    expect(parsed.skinWeight[0]).toBeCloseTo(1, 6);
    expect(basisLane(parsed.basis, 0)).toBeCloseTo(0.25, 6);
    expect(basisLane(parsed.basis, 1)).toBeCloseTo(0.5, 6);
    // Packing is deterministic, which is what makes a re-bake diff meaningful.
    expect([...packAosRig(header, blobs)]).toEqual([...packed]);
  });

  it('refuses a truncated pack rather than reading it as an empty rig', () => {
    // A GNM head that silently loads half its basis renders a face that moves a
    // little and looks nearly right — the failure mode with no symptom.
    expect(() => parseAosRig(packBytes.subarray(0, packBytes.length - 16))).toThrow(
      /truncated or corrupt/,
    );
    expect(() => parseAosRig(new Uint8Array(32))).toThrow(/not an \.aosrig pack/);
  });
});

describe('fp16 basis quantisation', () => {
  it('round-trips a half through both directions', () => {
    for (const value of [0, 1, -1, 0.5, 1e-4, -2.5, 65504]) {
      expect(halfToFloat(floatToHalf(value))).toBeCloseTo(value, Math.abs(value) > 1 ? 2 : 6);
    }
    expect(halfToFloat(floatToHalf(0))).toBe(0);
  });

  it('costs far less than the 1e-3 cm gate it has to fit inside', () => {
    // The per-coefficient scale maps each basis row's peak onto fp16's largest finite
    // value, so a row of millimetre deltas keeps its full mantissa. Measured here
    // against the packer's own recorded statistics.
    const pack = parseAosRig(packBytes);
    const stats = pack.header.source as Record<string, number> | undefined;
    expect(stats).toBeDefined();
    // 1e-3 cm is 1e-5 m; the quantisation has to be well inside it — and because the
    // scale is a POWER OF TWO and the baked basis is already fp16, it is EXACTLY zero.
    // A non-zero value here means the packer stopped using a power-of-two scale, which
    // measured 0.85 mm of accumulated drift the first time it happened.
    expect(stats!.basisMaxAbsErrorM).toBe(0);
    expect(stats!.basisMeanAbsErrorM).toBe(0);
    expect(stats!.basisPeakM).toBeGreaterThan(0);
  });
});

describe('gaze', () => {
  it('is the identity at zero', () => {
    // `+ 0` normalises the signed zero the `-sin·sin` term produces; -0 and 0 are the
    // same rotation and the shader cannot tell them apart either.
    const [left, right] = gazeToEyeRotations([0, 0, 0, 0]);
    expect(left.map((v) => v + 0)).toEqual([1, 0, 0, 0]);
    expect(right.map((v) => v + 0)).toEqual([1, 0, 0, 0]);
  });

  it('composes pitch THEN yaw, and the diagonal is what tells them apart', () => {
    // `R = Rx(pitch) · Ry(yaw)`. Swapping the order is right on each axis alone and
    // wrong on the diagonal, which is exactly the kind of thing that survives a look.
    const pitch = 0.3;
    const yaw = 0.4;
    const [q] = gazeToEyeRotations([pitch, yaw, 0, 0]);
    const cp = Math.cos(pitch / 2);
    const sp = Math.sin(pitch / 2);
    const cy = Math.cos(yaw / 2);
    const sy = Math.sin(yaw / 2);
    expect(q[0]).toBeCloseTo(cp * cy, 12);
    expect(q[1]).toBeCloseTo(sp * cy, 12);
    expect(q[2]).toBeCloseTo(cp * sy, 12);
    expect(q[3]).toBeCloseTo(sp * sy, 12);
  });

  it('splits head_ext into its expression and gaze halves', () => {
    const pack = parseAosRig(packBytes);
    const headExt = new Float32Array(387);
    headExt[0] = 1;
    headExt[383] = 0.1;
    headExt[386] = -0.2;
    const { expr, gaze } = unpackHeadExt(headExt, pack.header.headExt);
    expect(expr.length).toBe(383);
    expect(expr[0]).toBe(1);
    expect(gaze[0]).toBeCloseTo(0.1, 6);
    expect(gaze[1]).toBe(0);
    expect(gaze[2]).toBe(0);
    expect(gaze[3]).toBeCloseTo(-0.2, 6);
    expect(() => unpackHeadExt(new Float32Array(10), pack.header.headExt)).toThrow(/head_ext is/);
  });
});

describe('the TypeScript reference against the python oracle', () => {
  const pack = parseAosRig(packBytes);
  const reference = readNpz(referenceBytes);
  const headExt = reference.head_ext.data as Float32Array;
  const expected = reference.vertices.data as Float32Array;
  const [frames, vertices] = reference.vertices.shape;

  it('reads the fixture the tools wrote', () => {
    expect(frames).toBe(10);
    expect(vertices).toBe(pack.vertexCount);
    expect(reference.head_ext.shape).toEqual([frames, 387]);
    // Which oracle produced it is recorded so a failure says whether the real model or
    // the numpy linear model was the target.
    expect(['gnm', 'numpy']).toContain(npzText(referenceBytes, 'oracle'));
    // The fixture's own vertex ids, so a re-bake with a different subset is caught.
    expect(reference.vertex_ids.shape).toEqual([vertices]);
  });

  it('matches every frame to 1e-3 cm', () => {
    // 1e-3 cm = 1e-5 m, which is the M5 acceptance gate. The error here is fp16 basis
    // quantisation plus f32 accumulation; anything larger is a real divergence.
    const TOLERANCE_METRES = 1e-5;
    let worst = 0;
    let worstFrame = -1;
    for (let f = 0; f < frames; f++) {
      const frameExt = headExt.subarray(f * 387, (f + 1) * 387);
      const { vertices: actual } = gnmForward(pack, frameExt);
      for (let i = 0; i < actual.length; i++) {
        const error = Math.abs(actual[i] - expected[f * vertices * 3 + i]);
        if (error > worst) {
          worst = error;
          worstFrame = f;
        }
      }
    }
    // Name the frame in the failure: a drift that only shows on one pose is a
    // different bug from one that shows on all of them.
    if (worst >= TOLERANCE_METRES) {
      throw new Error(
        `worst error ${String(worst)} m at frame ${String(worstFrame)}, ` +
          `tolerance ${String(TOLERANCE_METRES)} m`,
      );
    }
    expect(worst).toBeLessThan(TOLERANCE_METRES);
  });

  it('reproduces the NEUTRAL exactly at the zero vector', () => {
    // Frame 0 of the fixture is the neutral, deliberately: a reference set whose every
    // row moves cannot tell you whether the neutral itself is right, and the neutral is
    // what everything else is a delta from.
    const { vertices: actual } = gnmForward(pack, new Float32Array(387));
    for (let i = 0; i < actual.length; i++) {
      expect(actual[i]).toBeCloseTo(pack.neutral[i], 6);
    }
  });

  it('applies the seam stitch and the skinning in `gnmPose`, not in `forward`', () => {
    // `forward` is head-local and pre-seam, which is what the oracle records; `pose`
    // adds the baked neck stitch and skins to the rig. At the pack's own rest the
    // skinning is the identity, so the difference is exactly the stitch, carried
    // through the bind transform.
    const headExtZero = new Float32Array(387);
    const forward = gnmForward(pack, headExtZero).vertices;
    const posed = gnmPose(pack, headExtZero);
    expect(posed.length).toBe(forward.length);
    let moved = 0;
    for (let i = 0; i < posed.length; i++) if (Math.abs(posed[i] - forward[i]) > 1e-6) moved++;
    expect(moved).toBeGreaterThan(0);
  });
});
