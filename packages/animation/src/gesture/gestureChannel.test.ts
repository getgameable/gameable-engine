// Ported from aos-threejs-poc/tests/unit/gestureChannelSuppression.test.mjs @ cdd63b10
import { describe, expect, it } from 'vitest';

import {
  ADDITIVE_BLEND_MODE,
  createGestureChannel,
  type GestureActionLike,
  LOOP_ONCE,
} from './gestureChannel';

/** A recording stand-in for three's AnimationAction. */
interface FakeAction extends GestureActionLike {
  /** Last weight written. */
  weight: number;
  /** Whether `play` has been called since the last `stop`. */
  running: boolean;
  /** How many times `setLoop` has been called. */
  loopWrites: number;
  /** How many times `blendMode` has been assigned. */
  blendWrites: number;
  /** Backing field for the counted `blendMode` accessor. */
  _blendMode: number;
}

/**
 * Build a fake action.
 *
 * @param baseBlendMode The blend mode it starts in, i.e. the one a gesture must
 *   hand back when its envelope ends.
 *
 * @returns The action.
 */
function fakeAction(baseBlendMode = 0): FakeAction {
  return {
    // `blendMode` is a real accessor so an assignment can be counted: writing
    // it every frame is the bug this counts.
    _blendMode: baseBlendMode,
    get blendMode(): number {
      return this._blendMode;
    },
    set blendMode(value: number) {
      this._blendMode = value;
      this.blendWrites += 1;
    },
    loop: 0,
    clampWhenFinished: false,
    weight: 0,
    running: false,
    loopWrites: 0,
    blendWrites: 0,
    setLoop(mode: number): void {
      this.loop = mode;
      this.loopWrites += 1;
    },
    setEffectiveWeight(w: number): void {
      this.weight = w;
    },
    isRunning(): boolean {
      return this.running;
    },
    play(): void {
      this.running = true;
    },
    stop(): void {
      this.running = false;
    },
    reset(): unknown {
      return this;
    },
  };
}

describe('createGestureChannel', () => {
  it('runs fade in, hold, fade out, clear', () => {
    let t = 0;
    const channel = createGestureChannel({ now: () => t });
    const action = fakeAction();
    const actions = new Map<string, GestureActionLike>([['wave', action]]);

    channel.play('wave', { durationMs: 1000, peakWeight: 0.8, fadeInMs: 200, fadeOutMs: 200 });
    t = 100;
    channel.apply(actions);
    expect(action.weight).toBeCloseTo(0.4, 6);
    expect(action.blendMode).toBe(ADDITIVE_BLEND_MODE);
    expect(action.loop).toBe(LOOP_ONCE);
    expect(action.running).toBe(true);

    t = 500;
    channel.apply(actions);
    expect(action.weight).toBeCloseTo(0.8, 6);

    t = 900;
    channel.apply(actions);
    expect(action.weight).toBeCloseTo(0.4, 6);

    t = 1000;
    channel.apply(actions);
    expect(action.weight).toBe(0);
    expect(action.running).toBe(false);
    expect(channel.isActive()).toBe(false);
  });

  it('writes loop and blend mode once, and hands the blend mode back at the end', () => {
    let t = 0;
    const channel = createGestureChannel({ now: () => t });
    // A base-layer clip: normal blend mode, borrowed for one gesture.
    const action = fakeAction(2500);
    const actions = new Map<string, GestureActionLike>([['wave', action]]);

    channel.play('wave', { durationMs: 1000, peakWeight: 1, fadeInMs: 100, fadeOutMs: 100 });
    for (t = 0; t < 900; t += 16) channel.apply(actions);

    // Fifty-odd frames of envelope, one write of each: `setLoop` on a running
    // action resets its loop counter, which is why this must not be per-frame.
    expect(action.loopWrites).toBe(1);
    expect(action.blendWrites).toBe(1);
    expect(action.blendMode).toBe(ADDITIVE_BLEND_MODE);
    expect(action.loop).toBe(LOOP_ONCE);
    expect(action.clampWhenFinished).toBe(true);

    t = 1001;
    channel.apply(actions);
    expect(channel.isActive()).toBe(false);
    // Restored: a base clip that is left additive drives the rig as a delta
    // forever after.
    expect(action.blendMode).toBe(2500);
    expect(action.blendWrites).toBe(2);
    expect(action.loopWrites).toBe(1);
  });

  it('restores the blend mode when a gesture is replaced or stopped', () => {
    let t = 0;
    const channel = createGestureChannel({ now: () => t });
    const action = fakeAction(2500);
    const actions = new Map<string, GestureActionLike>([['wave', action]]);

    channel.play('wave', { durationMs: 1000 });
    t = 100;
    channel.apply(actions);
    expect(action.blendMode).toBe(ADDITIVE_BLEND_MODE);

    // Replaced by a gesture on another clip: this action is not the gesture
    // layer's any more, so it goes back the way it was.
    channel.play('nod', { durationMs: 1000 });
    expect(action.blendMode).toBe(2500);

    channel.play('wave', { durationMs: 1000 });
    t = 200;
    channel.apply(actions);
    expect(action.blendMode).toBe(ADDITIVE_BLEND_MODE);
    channel.stop();
    expect(action.blendMode).toBe(2500);
  });

  it('is suppressed while an exclusive override owns the skeleton', () => {
    const channel = createGestureChannel({ now: () => 0 });
    channel.setExclusiveOverride(true);
    expect(channel.play('gesture_laugh', { durationMs: 1000 })).toBe(false);
    expect(channel.isActive()).toBe(false);
  });

  it('starts normally with no override in flight', () => {
    const channel = createGestureChannel({ now: () => 0 });
    expect(channel.play('gesture_laugh', { durationMs: 1000 })).toBe(true);
    expect(channel.isActive()).toBe(true);
    expect(channel.activeClip()).toBe('gesture_laugh');
  });

  it('starts again once the override releases', () => {
    const channel = createGestureChannel({ now: () => 0 });
    channel.setExclusiveOverride(true);
    channel.play('a');
    channel.setExclusiveOverride(false);
    expect(channel.play('a')).toBe(true);
  });

  it('keeps the channel alive while its clip is still missing', () => {
    let t = 0;
    const channel = createGestureChannel({ now: () => t });
    const actions = new Map<string, GestureActionLike>();
    channel.play('late', { durationMs: 1000 });
    t = 500;
    channel.apply(actions);
    expect(channel.isActive()).toBe(true);
    // Once the envelope has elapsed there is nothing worth playing.
    t = 1001;
    channel.apply(actions);
    expect(channel.isActive()).toBe(false);
  });

  it('replaces whatever was in flight', () => {
    const channel = createGestureChannel({ now: () => 0 });
    channel.play('a');
    channel.play('b');
    expect(channel.activeClip()).toBe('b');
    channel.stop();
    expect(channel.isActive()).toBe(false);
  });
});
