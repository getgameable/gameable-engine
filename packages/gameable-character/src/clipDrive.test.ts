import { describe, expect, it } from 'vitest';

import { createClipDrive, type ClipInfo, type ClipRequest } from './clipDrive.js';

const clips = new Map<string, ClipInfo>([
  ['idle', { duration: 2.5, loop: true }],
  ['wave', { duration: 3, loop: false }],
]);

function recorder(): { frames: ClipRequest[][]; send: (r: readonly ClipRequest[]) => void } {
  const frames: ClipRequest[][] = [];
  return { frames, send: (r) => frames.push(r.map((x) => ({ ...x }))) };
}

describe('createClipDrive', () => {
  it('cross-fades a one-shot in and returns to the looping clip before it ends', () => {
    const { frames, send } = recorder();
    const drive = createClipDrive(clips, send);
    drive.play('idle');
    drive.play('wave');
    expect(frames.at(-1)).toEqual([
      { name: 'wave', weight: 0, time: 0 },
      { name: 'idle', weight: 1 },
    ]);
    for (let t = 0; t < 2.8; t += 0.05) drive.update(0.05);
    expect(drive.current).toBe('idle');
  });

  it('ignores play of the one-shot already playing: no fade from nothing, no restart', () => {
    const { frames, send } = recorder();
    const drive = createClipDrive(clips, send);
    drive.play('idle');
    drive.play('wave');
    for (let t = 0; t < 1; t += 0.05) drive.update(0.05);
    const before = frames.length;
    expect(drive.play('wave')).toBe(false);
    expect(frames.length).toBe(before);
    expect(frames.at(-1)).toEqual([{ name: 'wave', weight: 1 }]);
    // it still returns to idle when the first play's wave ends, not a second later
    for (let t = 1; t < 2.8; t += 0.05) drive.update(0.05);
    expect(drive.current).toBe('idle');
  });

  it('ignores play of the looping clip already playing', () => {
    const { frames, send } = recorder();
    const drive = createClipDrive(clips, send);
    drive.play('idle');
    expect(drive.play('idle')).toBe(false);
    expect(frames).toHaveLength(1);
  });

  it('returns with the one-shot’s own fade, starting that long before it ends', () => {
    const { frames, send } = recorder();
    const drive = createClipDrive(clips, send);
    drive.play('idle');
    drive.play('wave', { fade: 1 });
    for (let t = 0; t < 1.9; t += 0.05) drive.update(0.05);
    expect(drive.current).toBe('wave');
    drive.update(0.15);
    expect(drive.current).toBe('idle');
    // the way back fades over a second too: a quarter of it in, idle is a little under 0.25
    for (let t = 0; t < 0.25; t += 0.05) drive.update(0.05);
    const idle = frames.at(-1)?.find((r) => r.name === 'idle');
    expect(idle?.weight).toBeGreaterThan(0.2);
    expect(idle?.weight).toBeLessThan(0.35);
  });

  it('returns to a clip the caller made loop, and keeps it looping', () => {
    const drive = createClipDrive(clips, () => undefined);
    drive.play('wave', { loop: true });
    drive.play('idle', { loop: false });
    for (let t = 0; t < 2.5; t += 0.05) drive.update(0.05);
    expect(drive.current).toBe('wave');
    // and no return is pending: it plays on
    for (let t = 0; t < 4; t += 0.05) drive.update(0.05);
    expect(drive.current).toBe('wave');
  });

  it('names the clips it has when asked for one it has not', () => {
    const drive = createClipDrive(clips, () => undefined);
    expect(() => drive.play('dance')).toThrow(/idle, wave/);
  });
});
