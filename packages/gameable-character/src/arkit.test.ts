/**
 * ARKit names as Apple spells them (camelCase) and as this repository does (PascalCase) both
 * land on the right index; an unknown name is refused rather than dropped.
 */
import { ARKIT_NAMES, arkitIndex } from '@gameable/animation';
import { describe, expect, it } from 'vitest';

import { writeArkitWeights } from './arkit.js';

describe('writeArkitWeights', () => {
  const out = new Float32Array(ARKIT_NAMES.length);

  it("takes Apple's camelCase and the repository's PascalCase alike", () => {
    writeArkitWeights({ jawOpen: 0.5, MouthSmileLeft: 0.8, eyeblinkright: 1 }, out);
    expect(out[arkitIndex('JawOpen')]).toBe(0.5);
    expect(out[arkitIndex('MouthSmileLeft')]).toBeCloseTo(0.8);
    expect(out[arkitIndex('EyeBlinkRight')]).toBe(1);
    expect(out.reduce((n, v) => n + (v > 0 ? 1 : 0), 0)).toBe(3);
  });

  it('zeroes what a later call leaves out', () => {
    writeArkitWeights({ jawOpen: 0.5 }, out);
    writeArkitWeights({ browInnerUp: 0.2 }, out);
    expect(out[arkitIndex('JawOpen')]).toBe(0);
  });

  it('takes 52 numbers in ARKit order', () => {
    const all = new Float32Array(ARKIT_NAMES.length).fill(0.25);
    expect(Array.from(writeArkitWeights(all, out))).toEqual(Array.from(all));
  });

  it('clamps every weight to [0, 1], by name and in order alike', () => {
    writeArkitWeights({ jawOpen: 2, mouthSmileLeft: -0.5, eyeBlinkLeft: Number.NaN }, out);
    expect(out[arkitIndex('JawOpen')]).toBe(1);
    expect(out[arkitIndex('MouthSmileLeft')]).toBe(0);
    expect(out[arkitIndex('EyeBlinkLeft')]).toBe(0);
    const list = new Float32Array(ARKIT_NAMES.length).fill(3);
    writeArkitWeights(list, out);
    expect(out.every((v) => v === 1)).toBe(true);
  });

  it('refuses a name that is not an ARKit blendshape', () => {
    expect(() => writeArkitWeights({ smile: 1 }, out)).toThrow(/not one of ARKit's 52/);
  });
});
