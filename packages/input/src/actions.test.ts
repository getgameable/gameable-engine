import { describe, expect, it } from 'vitest';

import { createActionMap } from './actions';
import { keyIndex } from './keycodes';
import { createInputState, setBit, type InputState } from './state';

/** The binding declaration every test in this file reads. */
const BINDINGS = {
  fire: ['LMB', 'GamepadRT'],
  jump: ['Space', 'GamepadA'],
  move: { axis2: ['A', 'D', 'S', 'W'], gamepadAxes: [0, 1] },
} as const;

/**
 * Connect gamepad slot 0 with the given buttons and axes.
 *
 * @param state The state to mutate.
 * @param buttons Standard-mapping button bitset.
 * @param axes Axis values, starting at axis 0.
 */
function connectPad(state: InputState, buttons: number, axes: number[] = []): void {
  const pad = state.gamepads[0];
  pad.connected = true;
  pad.buttons = buttons;
  pad.pressed = buttons;
  for (let i = 0; i < axes.length; i += 1) pad.axes[i] = axes[i];
}

describe('createActionMap', () => {
  it('reads a button action from any of its bindings', () => {
    const state = createInputState();
    const actions = createActionMap(BINDINGS, state);

    expect(actions.down('fire')).toBe(false);

    setBit(state.keysDown, keyIndex('LMB'), true);
    expect(actions.down('fire')).toBe(true);

    setBit(state.keysDown, keyIndex('LMB'), false);
    connectPad(state, 1 << 7); // right trigger
    expect(actions.down('fire')).toBe(true);
    expect(actions.pressed('fire')).toBe(true);
  });

  it('binds both halves of a left/right pair', () => {
    const state = createInputState();
    const actions = createActionMap({ sprint: ['Shift'] }, state);

    setBit(state.keysDown, keyIndex('ShiftRight'), true);
    expect(actions.down('sprint')).toBe(true);

    setBit(state.keysDown, keyIndex('ShiftRight'), false);
    setBit(state.keysDown, keyIndex('ShiftLeft'), true);
    expect(actions.down('sprint')).toBe(true);
  });

  it('reads pressed and released edges', () => {
    const state = createInputState();
    const actions = createActionMap(BINDINGS, state);

    setBit(state.keysPressed, keyIndex('Space'), true);
    expect(actions.pressed('jump')).toBe(true);
    expect(actions.down('jump')).toBe(false);
    expect(actions.released('jump')).toBe(false);

    state.keysPressed.fill(0);
    setBit(state.keysReleased, keyIndex('Space'), true);
    expect(actions.released('jump')).toBe(true);
  });

  it('ignores a disconnected pad', () => {
    const state = createInputState();
    const actions = createActionMap(BINDINGS, state);
    state.gamepads[0].buttons = 1 << 0;
    expect(actions.down('jump')).toBe(false);
    state.gamepads[0].connected = true;
    expect(actions.down('jump')).toBe(true);
  });

  it('reads an axis2 action from the keyboard', () => {
    const state = createInputState();
    const actions = createActionMap(BINDINGS, state);

    expect([...actions.axis2('move')]).toEqual([0, 0]);
    setBit(state.keysDown, keyIndex('W'), true);
    setBit(state.keysDown, keyIndex('D'), true);
    expect([...actions.axis2('move')]).toEqual([1, 1]);
  });

  it('reads an axis2 action from the stick, with a deadzone and inverted Y', () => {
    const state = createInputState();
    const actions = createActionMap(BINDINGS, state);

    connectPad(state, 0, [0.1, 0.1]); // inside the default deadzone
    expect([...actions.axis2('move')]).toEqual([0, 0]);

    connectPad(state, 0, [0, -1]); // stick fully up
    const [x, y] = actions.axis2('move');
    expect(x).toBe(0);
    expect(y).toBeCloseTo(1, 5); // up is +Y, like W

    connectPad(state, 0, [1, 0]);
    expect(actions.axis2('move')[0]).toBeCloseTo(1, 5);
  });

  it('honours invertGamepadY: false', () => {
    const state = createInputState();
    const actions = createActionMap(
      {
        look: { axis2: ['A', 'D', 'S', 'W'], gamepadAxes: [0, 1], invertGamepadY: false },
      } as const,
      state,
    );
    connectPad(state, 0, [0, -1]);
    expect(actions.axis2('look')[1]).toBeCloseTo(-1, 5);
  });

  it('clamps the sum of keyboard and stick', () => {
    const state = createInputState();
    const actions = createActionMap(BINDINGS, state);
    setBit(state.keysDown, keyIndex('D'), true);
    connectPad(state, 0, [1, 0]);
    expect(actions.axis2('move')[0]).toBe(1);
  });

  it('is readable as a button while any direction is held', () => {
    const state = createInputState();
    const actions = createActionMap(BINDINGS, state);
    setBit(state.keysDown, keyIndex('A'), true);
    expect(actions.down('move')).toBe(true);
  });

  it('writes into a reusable tuple', () => {
    const state = createInputState();
    const actions = createActionMap(BINDINGS, state);
    expect(actions.axis2('move')).toBe(actions.axis2('move'));
    const mine: [number, number] = [0, 0];
    expect(actions.axis2('move', state, mine)).toBe(mine);
  });

  it('can be pointed at another state', () => {
    const live = createInputState();
    const replay = createInputState();
    const actions = createActionMap(BINDINGS, live);

    setBit(replay.keysDown, keyIndex('Space'), true);
    expect(actions.down('jump')).toBe(false);
    expect(actions.down('jump', replay)).toBe(true);

    actions.bind(replay);
    expect(actions.down('jump')).toBe(true);
  });

  it('rejects typos at creation, not at 60 Hz', () => {
    expect(() => createActionMap({ fire: ['Mouse7'] })).toThrow(/unknown binding "Mouse7"/);
    expect(() => createActionMap({ move: { axis2: ['A', 'D', 'S', 'Wat'] } } as const)).toThrow(
      /unknown binding "Wat"/,
    );
  });

  it('reads through a handle exactly as it reads through a name', () => {
    const state = createInputState();
    const actions = createActionMap(BINDINGS, state);
    const fire = actions.handle('fire');
    const jump = actions.handle('jump');
    const move = actions.handle('move');

    // Handles are small, stable and 1-based, in declaration order.
    expect([fire, jump, move]).toEqual([1, 2, 3]);
    expect(actions.handle('fire')).toBe(fire);

    setBit(state.keysDown, keyIndex('LMB'), true);
    setBit(state.keysPressed, keyIndex('Space'), true);
    setBit(state.keysReleased, keyIndex('Space'), true);
    setBit(state.keysDown, keyIndex('D'), true);

    expect(actions.down(fire)).toBe(actions.down('fire'));
    expect(actions.pressed(jump)).toBe(actions.pressed('jump'));
    expect(actions.released(jump)).toBe(actions.released('jump'));
    expect([...actions.axis2(move)]).toEqual([...actions.axis2('move')]);
    expect(actions.down(fire)).toBe(true);
    expect(actions.pressed(jump)).toBe(true);
    expect(actions.released(jump)).toBe(true);
  });

  it('explains an unknown handle as well as an unknown name', () => {
    const actions = createActionMap(BINDINGS, createInputState());
    expect(() => actions.handle('fier')).toThrow(/unknown action "fier"/);
    expect(() => actions.down(0)).toThrow(/unknown action handle 0/);
    expect(() => actions.down(4)).toThrow(/handles run 1\.\.3/);
    expect(() => actions.axis2(actions.handle('fire'))).toThrow(/not an axis2/);
  });

  it('explains an unknown action name', () => {
    const actions = createActionMap(BINDINGS, createInputState());
    expect(() => actions.down('fier')).toThrow(/unknown action "fier"/);
    expect(actions.names).toEqual(['fire', 'jump', 'move']);
  });

  it('refuses axis2 on a button action and refuses an unbound map', () => {
    const actions = createActionMap(BINDINGS, createInputState());
    expect(() => actions.axis2('fire')).toThrow(/not an axis2/);
    expect(() => createActionMap(BINDINGS).down('fire')).toThrow(/no input state/);
  });
});
