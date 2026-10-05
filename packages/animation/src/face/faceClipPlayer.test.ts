// Ported from the FaceClipPlayer blending core of aos-threejs-poc @ cdd63b10
import { describe, expect, it } from 'vitest';

import { ARKIT_COUNT } from './arkitNames';
import { createFaceClipPlayer, type FaceClipData } from './faceClipPlayer';

/**
 * A clip whose channel 0 ramps over `values`, one frame per 0.5 s.
 *
 * @param values Channel-0 value per frame.
 *
 * @returns The clip data.
 */
function rampClip(values: number[]): FaceClipData {
  return {
    fps: 2,
    frames: values.map((v, i) => {
      const weights = new Float32Array(ARKIT_COUNT);
      weights[0] = v;
      return { timeCode: i * 0.5, blendshapeWeights: weights };
    }),
  };
}

describe('createFaceClipPlayer', () => {
  it('returns null when nothing is driven', () => {
    const player = createFaceClipPlayer({ now: () => 0 });
    player.addFaceClip('a', rampClip([0, 1]));
    expect(player.getBlendedWeights(null)).toBeNull();
    expect(player.getBlendedWeights(new Map())).toBeNull();
    expect(player.getBlendedWeights(new Map([['a', 0]]))).toBeNull();
  });

  it('interpolates between frames', () => {
    let t = 0;
    const player = createFaceClipPlayer({ now: () => t });
    player.addFaceClip('a', rampClip([0, 1]));
    player.getBlendedWeights(new Map([['a', 1]])); // starts the clip's clock
    t = 250; // a quarter of a second: half way between frame 0 and frame 1
    const out = player.getBlendedWeights(new Map([['a', 1]]));
    expect(out).not.toBeNull();
    expect(out?.[0]).toBeCloseTo(0.5, 5);
  });

  it('scales by the drive weight and sums across clips', () => {
    const player = createFaceClipPlayer({ now: () => 0 });
    player.addFaceClip('a', rampClip([1, 1]));
    player.addFaceClip('b', rampClip([1, 1]));
    const out = player.getBlendedWeights(
      new Map([
        ['a', 0.25],
        ['b', 0.5],
      ]),
    );
    expect(out?.[0]).toBeCloseTo(0.75, 5);
  });

  it('loops, and interpolates across the loop boundary', () => {
    let t = 0;
    const player = createFaceClipPlayer({ now: () => t });
    player.addFaceClip('a', rampClip([0, 1])); // duration 0.5 s
    player.getBlendedWeights(new Map([['a', 1]]));
    t = 750; // 1.5 loops
    const out = player.getBlendedWeights(new Map([['a', 1]]));
    expect(out?.[0]).toBeCloseTo(0.5, 5);
  });

  it('restarts a clip from frame 0 after its weight drops to zero', () => {
    let t = 0;
    const player = createFaceClipPlayer({ now: () => t });
    player.addFaceClip('a', rampClip([0, 1]));
    player.getBlendedWeights(new Map([['a', 1]]));
    t = 250;
    player.getBlendedWeights(new Map([['a', 1]]));
    t = 300;
    player.getBlendedWeights(new Map([['a', 0]])); // stops the clip
    t = 400;
    const out = player.getBlendedWeights(new Map([['a', 1]]));
    expect(out?.[0]).toBeCloseTo(0, 5); // restarted, not resumed at 0.5
  });

  it('aliases a clip without copying the frame data', () => {
    const player = createFaceClipPlayer({ now: () => 0 });
    player.addFaceClip('a', rampClip([1, 1]));
    expect(player.aliasClip('custom_face_7', 'a')).toBe(true);
    expect(player.aliasClip('custom_face_7', 'a')).toBe(true); // idempotent
    expect(player.aliasClip('nope', 'missing')).toBe(false);
    expect(player.aliasClip('a', 'a')).toBe(false);
    expect(player.hasClip('custom_face_7')).toBe(true);
  });

  it('synthesises frame times from fps when timeCode is omitted', () => {
    let t = 0;
    const player = createFaceClipPlayer({ now: () => t });
    const weightsA = new Float32Array(ARKIT_COUNT);
    const weightsB = new Float32Array(ARKIT_COUNT);
    weightsB[0] = 1;
    player.addFaceClip('a', {
      fps: 4,
      frames: [{ blendshapeWeights: weightsA }, { blendshapeWeights: weightsB }],
    });
    player.getBlendedWeights(new Map([['a', 1]])); // starts the clip's clock
    t = 125; // half of one 0.25 s frame
    expect(player.getBlendedWeights(new Map([['a', 1]]))?.[0]).toBeCloseTo(0.5, 5);
  });

  it('reuses one output buffer', () => {
    const player = createFaceClipPlayer({ now: () => 0 });
    player.addFaceClip('a', rampClip([1, 1]));
    const first = player.getBlendedWeights(new Map([['a', 1]]));
    const second = player.getBlendedWeights(new Map([['a', 1]]));
    expect(first).toBe(second);
    expect(first?.length).toBe(ARKIT_COUNT);
  });
});
