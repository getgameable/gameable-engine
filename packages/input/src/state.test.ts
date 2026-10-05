import { describe, expect, it } from 'vitest';

import { keyIndex, KEY_WORDS } from './keycodes';
import {
  axis2,
  clearEdges,
  createInputState,
  GAMEPAD_AXES,
  isDown,
  Mods,
  MouseButtons,
  resetInputState,
  setBit,
  wasPressed,
  wasReleased,
  type InputState,
} from './state';

/**
 * Build a state with the named keys held, pressed and released.
 *
 * @param down Bindings held this frame.
 * @param pressed Bindings that went down this frame.
 * @param released Bindings that came up this frame.
 *
 * @returns The hand-built state.
 */
function stateWith(down: string[] = [], pressed: string[] = [], released: string[] = []) {
  const state = createInputState();
  for (const name of down) setBit(state.keysDown, keyIndex(name), true);
  for (const name of pressed) setBit(state.keysPressed, keyIndex(name), true);
  for (const name of released) setBit(state.keysReleased, keyIndex(name), true);
  return state;
}

describe('createInputState', () => {
  it('matches the packed WIT layout', () => {
    const state: InputState = createInputState();
    expect(state.keysDown).toHaveLength(KEY_WORDS);
    expect(state.keysPressed).toHaveLength(KEY_WORDS);
    expect(state.keysReleased).toHaveLength(KEY_WORDS);
    expect(state.keysDown).toBeInstanceOf(Uint32Array);
    expect(state.mods).toBe(0);
    expect(state.focused).toBe(false);
    expect(state.mouse).toMatchObject({ x: 0, dx: 0, wheel: 0, buttons: 0, locked: false });
    expect(state.gamepads).toHaveLength(4);
    expect(state.gamepads[0].axes).toBeInstanceOf(Float32Array);
    expect(state.gamepads[0].axes).toHaveLength(GAMEPAD_AXES);
    expect(state.gamepads[2].index).toBe(2);
  });

  it('takes a gamepad slot count', () => {
    expect(createInputState(1).gamepads).toHaveLength(1);
  });
});

describe('bitset readers', () => {
  it('reads keys across word boundaries', () => {
    const state = stateWith(['KeyA', 'Space', 'Mouse0']);
    expect(isDown(state, keyIndex('KeyA'))).toBe(true); // word 0
    expect(isDown(state, keyIndex('Space'))).toBe(true); // word 1
    expect(isDown(state, keyIndex('Mouse0'))).toBe(true); // word 7
    expect(isDown(state, keyIndex('KeyB'))).toBe(false);
  });

  it('separates down, pressed and released', () => {
    const state = stateWith(['KeyW'], ['KeyW'], ['Space']);
    expect(isDown(state, keyIndex('W'))).toBe(true);
    expect(wasPressed(state, keyIndex('W'))).toBe(true);
    expect(wasReleased(state, keyIndex('W'))).toBe(false);
    expect(isDown(state, keyIndex('Space'))).toBe(false);
    expect(wasReleased(state, keyIndex('Space'))).toBe(true);
  });

  it('treats an unresolvable binding as never down', () => {
    const state = stateWith(['KeyW']);
    expect(isDown(state, keyIndex('nonsense'))).toBe(false);
    expect(isDown(state, -1)).toBe(false);
    expect(isDown(state, 256)).toBe(false);
    expect(wasPressed(state, -1)).toBe(false);
    expect(wasReleased(state, 9999)).toBe(false);
  });

  it('ignores out-of-range writes', () => {
    const state = createInputState();
    setBit(state.keysDown, -1, true);
    setBit(state.keysDown, 256, true);
    expect([...state.keysDown].every((word) => word === 0)).toBe(true);
  });
});

describe('axis2', () => {
  it('reads WASD as a signed pair', () => {
    const a = keyIndex('A');
    const d = keyIndex('D');
    const s = keyIndex('S');
    const w = keyIndex('W');

    expect([...axis2(stateWith(['KeyW']), a, d, s, w)]).toEqual([0, 1]);
    expect([...axis2(stateWith(['KeyS']), a, d, s, w)]).toEqual([0, -1]);
    expect([...axis2(stateWith(['KeyA']), a, d, s, w)]).toEqual([-1, 0]);
    expect([...axis2(stateWith(['KeyD', 'KeyW']), a, d, s, w)]).toEqual([1, 1]);
    // Opposite keys cancel rather than fighting.
    expect([...axis2(stateWith(['KeyA', 'KeyD']), a, d, s, w)]).toEqual([0, 0]);
  });

  it('returns the same tuple every call unless given one', () => {
    const state = stateWith(['KeyW']);
    const first = axis2(state, 0, 1, 2, 3);
    const second = axis2(state, 0, 1, 2, 3);
    expect(second).toBe(first);

    const mine: [number, number] = [0, 0];
    expect(axis2(state, 0, 1, 2, 3, mine)).toBe(mine);
    expect(mine).not.toBe(first);
  });
});

describe('clearEdges', () => {
  it('clears edges and deltas but not what is held', () => {
    const state = stateWith(['KeyW'], ['KeyW'], ['Space']);
    state.mods = Mods.Shift;
    state.mouse.buttons = MouseButtons.Left;
    state.mouse.pressed = MouseButtons.Left;
    state.mouse.dx = 12;
    state.mouse.wheel = -3;
    state.gamepads[0].pressed = 1;

    clearEdges(state);

    expect(isDown(state, keyIndex('W'))).toBe(true);
    expect(wasPressed(state, keyIndex('W'))).toBe(false);
    expect(wasReleased(state, keyIndex('Space'))).toBe(false);
    expect(state.mouse.buttons).toBe(MouseButtons.Left);
    expect(state.mouse.pressed).toBe(0);
    expect(state.mouse.dx).toBe(0);
    expect(state.mouse.wheel).toBe(0);
    expect(state.gamepads[0].pressed).toBe(0);
    expect(state.mods).toBe(Mods.Shift);
  });
});

describe('resetInputState', () => {
  it('returns everything to neutral', () => {
    const state = stateWith(['KeyW', 'Mouse0'], ['KeyW']);
    state.mods = Mods.Ctrl | Mods.Alt;
    state.mouse.buttons = MouseButtons.Right;
    state.gamepads[0].buttons = 0b11;
    state.gamepads[0].axes[0] = 0.5;

    resetInputState(state);

    expect([...state.keysDown].every((word) => word === 0)).toBe(true);
    expect(state.mods).toBe(0);
    expect(state.mouse.buttons).toBe(0);
    expect(state.gamepads[0].buttons).toBe(0);
    expect(state.gamepads[0].axes[0]).toBe(0);
  });
});
