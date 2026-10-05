// The fitted face table's player, against the formula it plays and, when the studio's files are
// at hand, against the studio's own reference vectors.
//
// The studio's table itself is not in the repository (its columns encode a MetaHuman rig; the
// package's NOTICE.md says so). To run the reference check, point GAMEABLE_FACE_REFERENCE at a
// folder holding a package's `character.json` and `arkit_to_gnm.bin` and the studio's
// `arkit_reference.json` (the studio's exporter writes it).

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { createFittedArkitMap } from './arkitFitted.js';
import type { ArkitFaceTableInfo } from '../aosrigSplat/format.js';
import { ARKIT_NAMES } from '../rig/arkit/arkitNames.js';
import type { HeadExtLayout } from '../rig/gnm/gnmPack.js';

const LAYOUT: HeadExtLayout = {
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
const N = 383;

/** Apple's spelling of one of our channel names. */
const apple = (name: string): string => name[0].toLowerCase() + name.slice(1);

/** A small table: five channels (one this reader does not know), two correctives, a gaze entry. */
function syntheticTable(): { info: ArkitFaceTableInfo; bytes: Uint8Array; rows: Float32Array } {
  const channels = ['eyeBlinkLeft', 'jawOpen', 'mouthClose', 'notAChannel', 'eyeLookUpLeft'];
  const pairs: [number, number][] = [
    [1, 2],
    [0, 3],
  ];
  const rows = new Float32Array((channels.length + pairs.length) * N);
  let seed = 3;
  for (let i = 0; i < rows.length; i++) {
    seed = (seed * 1103515245 + 12345) >>> 0;
    rows[i] = seed / 2 ** 32 - 0.5;
  }
  const info: ArkitFaceTableInfo = {
    src: 'arkit_to_gnm.bin',
    sha256: '0'.repeat(64),
    bytes: rows.byteLength,
    version: 1,
    coeffs: N,
    channels,
    pairs,
    gaze: { eyeLookUpLeft: { eye: 'left', axis: 'pitch', radians: 0.5 } },
  };
  return { info, bytes: new Uint8Array(rows.buffer), rows };
}

/** ARKit weights (our order) from Apple-spelled names. */
function weights(named: Record<string, number>): Float32Array {
  const out = new Float32Array(ARKIT_NAMES.length);
  for (const [name, w] of Object.entries(named)) {
    const i = ARKIT_NAMES.findIndex((n) => n.toLowerCase() === name.toLowerCase());
    if (i < 0) throw new Error(name);
    out[i] = w;
  }
  return out;
}

describe('createFittedArkitMap', () => {
  it('plays c A + clamp(c_i) clamp(c_j) C, the linear part unclamped', () => {
    const t = syntheticTable();
    const face = createFittedArkitMap(t, LAYOUT);
    expect(face.dim).toBe(387);
    expect(face.dropped).toEqual(['notAChannel']);
    const out = new Float32Array(face.dim);
    face.map(weights({ jawOpen: 1.5, mouthClose: 0.6, eyeBlinkLeft: -0.2 }), out);
    const row = (r: number, k: number): number => t.rows[r * N + k];
    for (const k of [0, 1, 200, 382]) {
      // jawOpen 1.5 and eyeBlinkLeft -0.2 unclamped; the pair (jaw, close) with jaw clamped to 1
      const want = 1.5 * row(1, k) + 0.6 * row(2, k) - 0.2 * row(0, k) + 1 * 0.6 * row(5, k);
      expect(out[k]).toBeCloseTo(want, 5);
    }
    // the pair naming the unknown channel is left out, not played against a wrong channel
    expect(face.terms).toBe(ARKIT_NAMES.length + 1);
  });

  it('is zero at rest, and turns the eye by the gaze gain in the head convention', () => {
    const face = createFittedArkitMap(syntheticTable(), LAYOUT);
    const out = new Float32Array(face.dim);
    face.map(new Float32Array(ARKIT_NAMES.length), out);
    expect(out.every((x) => x === 0)).toBe(true);
    face.map(weights({ eyeLookUpLeft: 2 }), out);
    // the table's pitch + is up; the head's pitch + is down; the weight is clamped to 1
    expect(out[383]).toBeCloseTo(-0.5, 6);
    expect(out[384]).toBe(0);
    expect(out[385]).toBe(0);
  });

  it('refuses a table made for another head', () => {
    const t = syntheticTable();
    expect(() => createFittedArkitMap(t, { ...LAYOUT, dim: 68, exprDim: 64 })).toThrow(
      /coefficients/,
    );
    expect(() =>
      createFittedArkitMap({ info: t.info, bytes: t.bytes.subarray(4) }, LAYOUT),
    ).toThrow(/bytes/);
  });

  it('takes every ARKit channel as Apple spells it', () => {
    for (const name of ARKIT_NAMES) expect(apple(name)).toMatch(/^[a-z]/);
  });
});

const referenceDir = process.env.GAMEABLE_FACE_REFERENCE;

describe.skipIf(!referenceDir)("the studio's reference vectors", () => {
  it('match within the reference tolerance', () => {
    const dir = referenceDir as string;
    const descriptor = JSON.parse(readFileSync(join(dir, 'character.json'), 'utf8')) as {
      face: { arkit: ArkitFaceTableInfo };
    };
    const info = descriptor.face.arkit;
    const bytes = new Uint8Array(readFileSync(join(dir, info.src)));
    const reference = JSON.parse(readFileSync(join(dir, 'arkit_reference.json'), 'utf8')) as {
      table: { sha256: string };
      tolerance: number;
      cases: { name: string; weights: Record<string, number>; coeffs: number[] }[];
    };
    expect(reference.table.sha256).toBe(info.sha256);
    const face = createFittedArkitMap({ info, bytes }, LAYOUT);
    expect(face.dropped).toEqual([]);
    const out = new Float32Array(face.dim);
    for (const c of reference.cases) {
      face.map(weights(c.weights), out);
      let worst = 0;
      for (let k = 0; k < N; k++) worst = Math.max(worst, Math.abs(out[k] - c.coeffs[k]));
      expect(worst, c.name).toBeLessThan(reference.tolerance);
    }
  });
});
