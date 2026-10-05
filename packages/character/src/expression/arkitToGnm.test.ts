// The ARKit -> GNM stopgap table, checked for the things that make a map WRONG rather
// than merely approximate: an index outside the layout, an absolute index that stops
// meaning the same thing under truncation, a per-frame allocation, a gaze convention
// that disagrees with `gnmPack.ts`.
//
// Nothing here asserts that a blink looks like a blink. That claim cannot be made by a
// node test and is not made by this table at all — see the module's own header.

import { describe, expect, it } from 'vitest';

import { ARKIT_TO_GNM_DEFAULT, createArkitToGnmMap, GAZE_FULL_SCALE } from './arkitToGnmDefault.js';
import { ARKIT_NAMES } from '../rig/arkit/arkitNames.js';
import { regionSlices, type HeadExtLayout } from '../rig/gnm/gnmPack.js';

/** The shipped head's layout: 383 + 4. */
const FULL: HeadExtLayout = {
  dim: 387,
  exprDim: 383,
  gazeDim: 4,
  regions: [
    ['left_eye', 100],
    ['right_eye', 100],
    ['lower_face', 150],
    ['tongue', 32],
    ['pupils', 1],
  ],
  reduced: { left_eye: 16, right_eye: 16, lower_face: 28, tongue: 3, pupils: 1 },
};

/** What `gnm_pack.py --trunc-exp 64` writes: the reduced view, as its own layout. */
const REDUCED: HeadExtLayout = {
  dim: 68,
  exprDim: 64,
  gazeDim: 4,
  regions: [
    ['left_eye', 16],
    ['right_eye', 16],
    ['lower_face', 28],
    ['tongue', 3],
    ['pupils', 1],
  ],
  reduced: { left_eye: 16, right_eye: 16, lower_face: 28, tongue: 3, pupils: 1 },
};

/**
 * An ARKit vector with one channel raised.
 *
 * @param name The channel to raise, by its `ARKIT_NAMES` spelling.
 * @param weight The weight to set. Defaults to 1.
 * @returns A fresh 52-long vector, zero everywhere else.
 */
function arkitWith(name: string, weight = 1): Float32Array {
  const out = new Float32Array(ARKIT_NAMES.length);
  out[ARKIT_NAMES.indexOf(name)] = weight;
  return out;
}

describe('the default table', () => {
  it('names only real ARKit-52 channels', () => {
    for (const name of Object.keys(ARKIT_TO_GNM_DEFAULT)) {
      expect(ARKIT_NAMES, name).toContain(name);
    }
  });

  it('covers blink, jaw, smile and brow — the four the showcase drives', () => {
    for (const name of [
      'EyeBlinkLeft',
      'EyeBlinkRight',
      'JawOpen',
      'MouthSmileLeft',
      'MouthSmileRight',
      'BrowInnerUp',
      'BrowDownLeft',
    ]) {
      expect(ARKIT_TO_GNM_DEFAULT[name].length, name).toBeGreaterThan(0);
    }
  });

  it('stays inside the 64-coefficient reduced view, so one table drives both packs', () => {
    // This is the property that lets the showcase default to the truncated pack. An
    // entry outside it would be silently dropped there and the face would be missing a
    // behaviour on one pack only, which is the worst way to find out.
    for (const [name, terms] of Object.entries(ARKIT_TO_GNM_DEFAULT)) {
      for (const term of terms) {
        expect(term.index, `${name} -> ${term.region}`).toBeLessThan(
          REDUCED.reduced[term.region] ?? 0,
        );
      }
    }
  });

  it('is REGION-RELATIVE, so truncation renumbers the slots and the meaning survives', () => {
    const full = createArkitToGnmMap(FULL);
    const reduced = createArkitToGnmMap(REDUCED);
    expect(full.dropped).toEqual([]);
    expect(reduced.dropped).toEqual([]);
    expect(reduced.terms).toBe(full.terms);

    // `lower_face` starts at 200 in the full layout and at 32 in the reduced one, and a
    // JawOpen written with an absolute index would land in `left_eye` on one of them.
    const outFull = new Float32Array(FULL.dim);
    const outReduced = new Float32Array(REDUCED.dim);
    full.map(arkitWith('JawOpen'), outFull);
    reduced.map(arkitWith('JawOpen'), outReduced);
    const fullSlice = regionSlices(FULL).lower_face;
    const reducedSlice = regionSlices(REDUCED).lower_face;
    expect(outFull[fullSlice.start + 9]).toBeCloseTo(3, 6);
    expect(outReduced[reducedSlice.start + 9]).toBeCloseTo(3, 6);
    expect(fullSlice.start).not.toBe(reducedSlice.start);
  });
});

describe('the mapper', () => {
  it('zeroes everything it does not drive, every call', () => {
    const { map, dim } = createArkitToGnmMap(FULL);
    const out = new Float32Array(dim);
    map(arkitWith('JawOpen'), out);
    const drivenByJaw = out.filter((v) => v !== 0).length;
    expect(drivenByJaw).toBeGreaterThan(0);
    map(new Float32Array(ARKIT_NAMES.length), out);
    // A stale coefficient from the previous frame is a face stuck mid-expression.
    expect([...out].every((v) => v === 0)).toBe(true);
  });

  it('allocates nothing per frame', () => {
    // The whole reason the table is resolved to flat arrays at build time: this runs in
    // `Animator.update`, which AGENTS.md rule 2 forbids allocating in.
    const { map, dim } = createArkitToGnmMap(FULL);
    const out = new Float32Array(dim);
    const arkit = arkitWith('EyeBlinkLeft');
    const before = out.buffer;
    for (let i = 0; i < 100; i++) map(arkit, out);
    expect(out.buffer).toBe(before);
  });

  it('sums two channels into the same coefficient and clamps the total', () => {
    const { map, dim } = createArkitToGnmMap(FULL, { clamp: 2 });
    const out = new Float32Array(dim);
    const arkit = new Float32Array(ARKIT_NAMES.length);
    arkit[ARKIT_NAMES.indexOf('BrowInnerUp')] = 1;
    arkit[ARKIT_NAMES.indexOf('BrowOuterUpLeft')] = 1;
    map(arkit, out);
    // 1.5 + 2.0 = 3.5, clamped to 2.
    expect(out[regionSlices(FULL).left_eye.start]).toBe(2);
  });

  it('opposes blink and wide on the same coefficient', () => {
    const { map, dim } = createArkitToGnmMap(FULL);
    const blink = new Float32Array(dim);
    const wide = new Float32Array(dim);
    map(arkitWith('EyeBlinkLeft'), blink);
    map(arkitWith('EyeWideLeft'), wide);
    const slot = regionSlices(FULL).left_eye.start + 2;
    expect(Math.sign(blink[slot])).toBe(-Math.sign(wide[slot]));
  });

  it('fills gaze from the EyeLook channels, in the pack’s own convention', () => {
    // `gnmPack.ts`: pitch > 0 looks DOWN, yaw > 0 looks toward character-LEFT.
    const { map, dim } = createArkitToGnmMap(FULL);
    const out = new Float32Array(dim);
    map(arkitWith('EyeLookDownLeft'), out);
    expect(out[FULL.exprDim]).toBeCloseTo(GAZE_FULL_SCALE, 6);
    map(arkitWith('EyeLookUpLeft'), out);
    expect(out[FULL.exprDim]).toBeCloseTo(-GAZE_FULL_SCALE, 6);
    // Looking to the character's left is "out" for the left eye and "in" for the right,
    // and both eyes must end up with the SAME sign or they cross.
    map(arkitWith('EyeLookOutLeft'), out);
    const yawL = out[FULL.exprDim + 1];
    map(arkitWith('EyeLookInRight'), out);
    const yawR = out[FULL.exprDim + 3];
    expect(Math.sign(yawL)).toBe(Math.sign(yawR));
  });

  it('can be built without the gaze half, for a caller that drives gaze itself', () => {
    const { map, dim } = createArkitToGnmMap(FULL, { gaze: false });
    const out = new Float32Array(dim);
    map(arkitWith('EyeLookDownLeft'), out);
    expect(out[FULL.exprDim]).toBe(0);
  });

  it('drops — and reports — a term a pack does not carry, instead of aliasing it', () => {
    const narrow: HeadExtLayout = {
      dim: 12,
      exprDim: 8,
      gazeDim: 4,
      regions: [
        ['left_eye', 4],
        ['right_eye', 4],
      ],
      reduced: { left_eye: 4, right_eye: 4 },
    };
    const { dropped, terms } = createArkitToGnmMap(narrow);
    expect(terms).toBeGreaterThan(0);
    expect(dropped.join('\n')).toMatch(/lower_face/);
    expect(dropped.join('\n')).toMatch(/truncated away|no "lower_face" region/);
  });
});
