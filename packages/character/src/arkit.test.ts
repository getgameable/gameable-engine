// ARKit-52 -> the bundle's own control vector.
//
// Three stages, each with its own way of being silently wrong:
//
//   arkitToMh          52 ARKit weights -> 188 MetaHuman board controls. The exact map
//                      the decoders' training data was generated with; a change here is
//                      a face that moves differently from the one that was trained.
//   gatherFromRigNames the bundle's `rig_names.json` -> indices into those 188. Derived
//                      at LOAD time from the bundle rather than baked per character.
//   arkitToRig         the gather, plus the bundle's rest pose and its trained limits.

import { describe, expect, it } from 'vitest';

import { ARKIT_NAMES } from './rig/arkit/arkitNames.js';
import { arkitToMh, MH_LEN } from './rig/arkit/arkitToMh.js';
import { arkitToRig } from './rig/arkit/arkitToRig.js';
import { gatherFromRigNames } from './rig/arkit/rigGatherFromNames.js';
import { MH_RIG_NAMES } from './rig/arkit/rigNamesMh.js';

describe('the canonical orderings', () => {
  it('carries 52 ARKit channels and 188 MetaHuman controls', () => {
    expect(ARKIT_NAMES.length).toBe(52);
    expect(ARKIT_NAMES[0]).toBe('EyeBlinkLeft');
    expect(ARKIT_NAMES[51]).toBe('TongueOut');
    expect(MH_RIG_NAMES.length).toBe(MH_LEN);
    expect(MH_LEN).toBe(188);
    expect(new Set(MH_RIG_NAMES).size).toBe(188);
  });
});

describe('arkitToMh', () => {
  it('maps an ARKit-neutral frame to an all-zero MH vector', () => {
    // ARKit weights are deltas from neutral BY DEFINITION (0 = neutral, 1 = full
    // expression), and the MH space shares that convention. This is what lets the ARKit
    // contribution be ADDED to a rest pose rather than replacing it.
    const out = arkitToMh(new Float32Array(52), new Float32Array(MH_LEN));
    expect([...out].every((v) => v === 0)).toBe(true);
  });

  it('ZEROES the destination first', () => {
    // Many of the 188 indices are never written; without the fill they would carry over
    // from the previous frame, so a smile would leave a residue on the next syllable.
    const out = new Float32Array(MH_LEN).fill(0.9);
    arkitToMh(new Float32Array(52), out);
    expect([...out].every((v) => v === 0)).toBe(true);
  });

  it('keeps the signed left/right splits', () => {
    // Several MH controls are DIFFERENCES of an ARKit pair, and their DNA counterparts
    // are genuinely bipolar — clamping to [0,1] would kill half of every such range.
    const arkit = new Float32Array(52);
    arkit[0] = 1; // EyeBlinkLeft
    const left = arkitToMh(arkit, new Float32Array(MH_LEN));
    expect(left[42]).toBe(1);

    arkit[0] = 0;
    arkit[6] = 1; // EyeWideLeft
    const wide = arkitToMh(arkit, new Float32Array(MH_LEN));
    expect(wide[42]).toBe(-1);
  });

  it('applies the lipsTogether corrective as a RATIO of jaw open', () => {
    // `MouthClose` is meaningful only relative to `JawOpen`: sent absolutely it closes
    // the mouth on a face whose jaw is already shut.
    const arkit = new Float32Array(52);
    arkit[17] = 0.5; // JawOpen
    arkit[18] = 0.25; // MouthClose
    const out = arkitToMh(arkit, new Float32Array(MH_LEN));
    for (const index of [73, 74, 147, 148]) expect(out[index]).toBeCloseTo(0.5, 6);

    // Clamped at 1: a MouthClose above the jaw opening cannot over-drive the corrective.
    arkit[18] = 5;
    const clamped = arkitToMh(arkit, new Float32Array(MH_LEN));
    for (const index of [73, 74, 147, 148]) expect(clamped[index]).toBe(1);

    // With the jaw shut the raw value passes through.
    arkit[17] = 0;
    arkit[18] = 0.3;
    const shut = arkitToMh(arkit, new Float32Array(MH_LEN));
    expect(shut[73]).toBeCloseTo(0.3, 6);
  });

  it('mirrors a symmetric control to both sides', () => {
    const arkit = new Float32Array(52);
    arkit[19] = 0.4; // MouthFunnel
    const out = arkitToMh(arkit, new Float32Array(MH_LEN));
    for (const index of [63, 64, 137, 138]) expect(out[index]).toBeCloseTo(0.4, 6);
  });
});

describe('gatherFromRigNames', () => {
  it("derives the gather from the bundle, in the bundle's own order", () => {
    const gather = gatherFromRigNames([MH_RIG_NAMES[10], MH_RIG_NAMES[3], MH_RIG_NAMES[187]]);
    expect(gather).toEqual([10, 3, 187]);
  });

  it('THROWS on a control space the 188 ordering cannot express', () => {
    // Loud, so the caller reports "no lip-sync" rather than decoding garbage.
    expect(() => gatherFromRigNames(['CTRL_not_a_control'])).toThrow(/not in the 188/);
    expect(() => gatherFromRigNames([])).toThrow(/non-empty/);
  });

  it('names the missing controls, up to five, so the report is actionable', () => {
    const missing = ['a', 'b', 'c', 'd', 'e', 'f'];
    expect(() => gatherFromRigNames(missing)).toThrow(/6 control\(s\)/);
    expect(() => gatherFromRigNames(missing)).toThrow(/a, b, c, d, e, …/);
  });
});

describe('arkitToRig', () => {
  // A three-control bundle whose names are a subset of the 188.
  const names = [MH_RIG_NAMES[42], MH_RIG_NAMES[17], MH_RIG_NAMES[187]];
  const gather = gatherFromRigNames(names);

  it("gathers the bundle's N controls out of the 188", () => {
    const arkit = new Float32Array(52);
    arkit[0] = 1; // EyeBlinkLeft -> MH 42
    const out = arkitToRig(arkit, gather, new Float32Array(3));
    expect(out[0]).toBe(1);
    expect(out[1]).toBe(0);
    expect(out[2]).toBe(0);
  });

  it('ADDS to a rest pose rather than replacing it', () => {
    // arkitToMh ZEROES every control it does not write, so without a rest vector the
    // output is "the few controls ARKit reached, and 0 everywhere else" — which is only
    // a neutral face for a control space centred on 0. For one declaring [0,1] it is an
    // extreme corner the decoders never saw, and the result is a washed-out face.
    const rest = Float32Array.from([0.2, 0.3, 0.4]);
    const neutral = arkitToRig(new Float32Array(52), gather, new Float32Array(3), undefined, rest);
    // f32 round-trip, so `toBeCloseTo` rather than an exact compare.
    expect(neutral[0]).toBeCloseTo(0.2, 6);
    expect(neutral[1]).toBeCloseTo(0.3, 6);
    expect(neutral[2]).toBeCloseTo(0.4, 6);

    const arkit = new Float32Array(52);
    arkit[0] = 0.5;
    const posed = arkitToRig(arkit, gather, new Float32Array(3), undefined, rest);
    expect(posed[0]).toBeCloseTo(0.7, 6);
    expect(posed[1]).toBeCloseTo(0.3, 6);
  });

  it('ignores a rest vector whose width does not match the gather', () => {
    const out = arkitToRig(
      new Float32Array(52),
      gather,
      new Float32Array(3),
      undefined,
      Float32Array.from([1, 2]),
    );
    expect([...out]).toEqual([0, 0, 0]);
  });

  it('clamps to the declared range once a rest is in play', () => {
    // Rest is already inside the domain, so adding a full expression on top can leave
    // it — and a control outside its declared range is the extrapolation `rest` exists
    // to avoid.
    const rest = Float32Array.from([0.8, 0, 0]);
    const arkit = new Float32Array(52);
    arkit[0] = 1;
    const out = arkitToRig(arkit, gather, new Float32Array(3), undefined, rest, [0, 1]);
    expect(out[0]).toBe(1);
  });

  it('prefers PER-CONTROL trained limits over the declared range', () => {
    // `rig_range` is the space's nominal domain; the training data occupies a far
    // narrower per-control box inside it. One ARKit channel at 1.0 can sit MULTIPLES
    // past anything the decoders saw — measured, five to seven times over — and that is
    // the blown-out, exploding face.
    const rest = Float32Array.from([0, 0, 0]);
    const arkit = new Float32Array(52);
    arkit[0] = 1;
    const perControl: [number, number][] = [
      [0, 0.205],
      [0, 1],
      [0, 1],
    ];
    const out = arkitToRig(arkit, gather, new Float32Array(3), undefined, rest, perControl);
    expect(out[0]).toBeCloseTo(0.205, 6);
  });

  it('reuses a caller-supplied scratch buffer', () => {
    // The hot path must not allocate a 188-float array per frame.
    const scratch = new Float32Array(MH_LEN);
    const arkit = new Float32Array(52);
    arkit[0] = 1;
    arkitToRig(arkit, gather, new Float32Array(3), scratch);
    expect(scratch[42]).toBe(1);
  });
});
