import { expect, it } from 'vitest';
import { retargetStationaryGesture } from './preparedGesture';
it('maps a source rest pose to additive identity despite different target rests', () => {
  const q = Math.SQRT1_2;
  const clip = retargetStationaryGesture(
    'rest',
    { fps: 30, frames: 2, bones: { arm: [0, q, 0, q, 0, q, 0, q] } },
    {
      names: ['root', 'arm'],
      parents: [-1, 0],
      rotations: [
        [q, 0, 0, q],
        [0, q, 0, q],
      ],
    },
    {
      names: ['root', 'hand'],
      parents: [-1, 0],
      rotations: [
        [0, 0, q, q],
        [q, 0, 0, q],
      ],
    },
    { arm: 'hand' },
  );
  expect(clip.tracks[0].name).toBe('hand.quaternion');
  for (let i = 0; i < 8; i++) expect(clip.tracks[0].values[i]).toBeCloseTo(i % 4 === 3 ? 1 : 0);
});
it('leaves pelvis, legs and translation untouched for a stationary interview', () => {
  const rest = {
    names: ['pelvis', 'foot', 'arm'],
    parents: [-1, 0, 0],
    rotations: [
      [0, 0, 0, 1],
      [0, 0, 0, 1],
      [0, 0, 0, 1],
    ],
  };
  const clip = retargetStationaryGesture(
    'gesture',
    {
      fps: 30,
      frames: 2,
      bones: {
        pelvis: [0, 0, 0, 1, 0, 1, 0, 0],
        foot: [0, 0, 0, 1, 0, 1, 0, 0],
        arm: [0, 0, 0, 1, 0, 1, 0, 0],
      },
    },
    rest,
    rest,
    { arm: 'arm' },
  );
  expect(clip.tracks.map((t) => t.name)).toEqual(['arm.quaternion']);
});
