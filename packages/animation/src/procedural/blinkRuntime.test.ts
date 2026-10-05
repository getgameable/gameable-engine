import { describe, expect, it } from 'vitest';

import { ARKIT_COUNT, ARKIT_EYE_BLINK_LEFT, ARKIT_EYE_BLINK_RIGHT } from '../face/arkitNames';
import { BLINK_DEFAULTS, createBlinkRuntime } from './blinkRuntime';

/**
 * A blink runtime on a controllable clock that blinks immediately.
 *
 * @returns The runtime and a setter for the clock.
 */
function harness(): { blink: ReturnType<typeof createBlinkRuntime>; at: (t: number) => void } {
  let t = 0;
  const blink = createBlinkRuntime({
    now: () => t,
    random: () => 0,
    config: { minInterval: 0, maxInterval: 0 },
  });
  blink.setConfig({ minInterval: 0, maxInterval: 0 });
  blink.reset();
  return {
    blink,
    at: (next: number) => {
      t = next;
    },
  };
}

describe('createBlinkRuntime', () => {
  it('runs the close / hold / open envelope', () => {
    const { blink, at } = harness();
    at(0);
    expect(blink.currentWeight(1)).toBeCloseTo(0, 6); // the blink starts here
    at(40);
    expect(blink.currentWeight(1)).toBeCloseTo(0.5, 6); // half way through closeMs
    at(100);
    expect(blink.currentWeight(1)).toBeCloseTo(1, 6); // the hold
    at(170);
    expect(blink.currentWeight(1)).toBeCloseTo(0.5, 6); // half way back open
    at(BLINK_DEFAULTS.closeMs + BLINK_DEFAULTS.holdMs + BLINK_DEFAULTS.openMs);
    expect(blink.currentWeight(1)).toBe(0); // finished and rescheduled
  });

  it('is a no-op at gate 0, and scales by the gate otherwise', () => {
    const { blink, at } = harness();
    at(0);
    expect(blink.currentWeight(0)).toBe(0);
    blink.currentWeight(1);
    at(40);
    expect(blink.currentWeight(0.5)).toBeCloseTo(0.25, 6);
  });

  it('adds onto the ARKit blink channels rather than replacing them', () => {
    const { blink, at } = harness();
    const arkit = new Float32Array(ARKIT_COUNT);
    arkit[ARKIT_EYE_BLINK_LEFT] = 0.2;
    at(0);
    blink.applyToArkit(arkit, 1);
    at(40);
    const applied = blink.applyToArkit(arkit, 1);
    expect(applied).toBeCloseTo(0.5, 6);
    expect(arkit[ARKIT_EYE_BLINK_LEFT]).toBeCloseTo(0.7, 6);
    expect(arkit[ARKIT_EYE_BLINK_RIGHT]).toBeCloseTo(0.5, 6);
  });

  it('clamps the summed channel to 1', () => {
    const { blink, at } = harness();
    const arkit = new Float32Array(ARKIT_COUNT);
    arkit[ARKIT_EYE_BLINK_LEFT] = 0.9;
    at(0);
    blink.applyToArkit(arkit, 1);
    at(100);
    blink.applyToArkit(arkit, 1);
    expect(arkit[ARKIT_EYE_BLINK_LEFT]).toBeCloseTo(1, 6);
  });

  it('setConfig is last-writer-wins and a partial patch reverts to defaults', () => {
    const blink = createBlinkRuntime({ now: () => 0, random: () => 0 });
    blink.setConfig({ closeMs: 10, holdMs: 10 });
    blink.setConfig({ closeMs: 20 });
    expect(blink.config.closeMs).toBe(20);
    expect(blink.config.holdMs).toBe(BLINK_DEFAULTS.holdMs);
  });

  it('gives every character its own phase', () => {
    const a = createBlinkRuntime({ now: () => 0, random: () => 0 });
    const b = createBlinkRuntime({ now: () => 0, random: () => 1 });
    expect(a.config).not.toBe(b.config);
  });
});
