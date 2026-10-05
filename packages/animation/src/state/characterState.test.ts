import { describe, expect, it } from 'vitest';

import { IDLE_CHARACTER_STATE, planarSpeed, validateCharacterState } from './characterState';

describe('validateCharacterState', () => {
  it('accepts the minimum state', () => {
    const state = validateCharacterState({ velocity: [1, 0, 0], grounded: true });
    expect(state.velocity).toEqual([1, 0, 0]);
    expect(state.grounded).toBe(true);
    expect(state.lookAt).toBeNull();
    expect(state.clips).toBeUndefined();
  });

  it('rejects a NaN velocity at the boundary', () => {
    expect(() => validateCharacterState({ velocity: [Number.NaN, 0, 0], grounded: true })).toThrow(
      /velocity\[0\] must be a finite number/,
    );
  });

  it('rejects a velocity that is not three numbers', () => {
    expect(() => validateCharacterState({ velocity: [1, 0], grounded: true })).toThrow(
      /3-element array/,
    );
    expect(() => validateCharacterState({ grounded: true })).toThrow(/3-element array/);
  });

  it('requires grounded to be a boolean', () => {
    expect(() => validateCharacterState({ velocity: [0, 0, 0], grounded: 1 })).toThrow(
      /grounded must be a boolean/,
    );
  });

  it('validates lookAt when it is present', () => {
    const state = validateCharacterState({
      velocity: [0, 0, 0],
      grounded: true,
      lookAt: [1, 2, 3],
    });
    expect(state.lookAt).toEqual([1, 2, 3]);
    expect(() =>
      validateCharacterState({ velocity: [0, 0, 0], grounded: true, lookAt: ['a', 2, 3] }),
    ).toThrow(/lookAt\[0\]/);
  });

  it('validates each clip request', () => {
    const state = validateCharacterState({
      velocity: [0, 0, 0],
      grounded: true,
      clips: [{ name: 'idle', weight: 1, time: 0.5 }],
    });
    expect(state.clips).toEqual([{ name: 'idle', weight: 1, time: 0.5 }]);
    expect(() =>
      validateCharacterState({ velocity: [0, 0, 0], grounded: true, clips: [{ weight: 1 }] }),
    ).toThrow(/clips\[0\]\.name/);
    expect(() =>
      validateCharacterState({ velocity: [0, 0, 0], grounded: true, clips: [{ name: 'a' }] }),
    ).toThrow(/clips\[0\]\.weight/);
    expect(() =>
      validateCharacterState({
        velocity: [0, 0, 0],
        grounded: true,
        clips: [{ name: 'a', weight: 1, time: 'x' }],
      }),
    ).toThrow(/clips\[0\]\.time/);
  });

  it('requires the expression vector to be a Float32Array', () => {
    const expression = new Float32Array(52);
    const state = validateCharacterState({ velocity: [0, 0, 0], grounded: true, expression });
    // Not copied: it is the hot path and the guest owns a stable buffer.
    expect(state.expression).toBe(expression);
    expect(() =>
      validateCharacterState({ velocity: [0, 0, 0], grounded: true, expression: [0, 1] }),
    ).toThrow(/Float32Array/);
  });

  it('rejects a non-object', () => {
    expect(() => validateCharacterState(null)).toThrow(/must be an object/);
    expect(() => validateCharacterState('idle')).toThrow(/must be an object/);
  });
});

describe('planarSpeed', () => {
  it('ignores Y, so a falling character is not sprinting', () => {
    expect(planarSpeed({ velocity: [3, -9, 4], grounded: false })).toBeCloseTo(5, 9);
    expect(planarSpeed(IDLE_CHARACTER_STATE)).toBe(0);
  });
});
