import { describe, expect, it } from 'vitest';

import { defineGame } from './defineGame';
import { input, MOUSE_BUTTONS } from './input';
import { KEY_COUNT, KEY_NAMES, keyIndex, keyIndex2, readKeyBit, writeKeyBit } from './keycodes';
import { createGuest } from './runtime';
import { createStubHost, hold, stubConfig, stubFrame, stubInput } from './testing';

describe('the key table', () => {
  it('pins the frozen indices the WIT bitsets depend on', () => {
    expect(keyIndex('KeyA')).toBe(0);
    expect(keyIndex('KeyZ')).toBe(25);
    expect(keyIndex('Digit0')).toBe(26);
    expect(keyIndex('Digit9')).toBe(35);
    expect(keyIndex('F1')).toBe(36);
    expect(keyIndex('F24')).toBe(59);
    expect(keyIndex('ArrowUp')).toBe(60);
    expect(keyIndex('ArrowRight')).toBe(63);
    expect(keyIndex('Space')).toBe(64);
    expect(keyIndex('Delete')).toBe(69);
    expect(keyIndex('ShiftLeft')).toBe(70);
    expect(keyIndex('MetaRight')).toBe(77);
  });

  it('has no duplicate names and fits in 256 bits', () => {
    expect(new Set(KEY_NAMES).size).toBe(KEY_NAMES.length);
    expect(KEY_COUNT).toBeLessThanOrEqual(256);
  });

  it('accepts bare letters, digits and aliases', () => {
    expect(keyIndex('W')).toBe(keyIndex('KeyW'));
    expect(keyIndex('w')).toBe(keyIndex('KeyW'));
    expect(keyIndex('1')).toBe(keyIndex('Digit1'));
    expect(keyIndex('Esc')).toBe(keyIndex('Escape'));
    expect(keyIndex('Shift')).toBe(keyIndex('ShiftLeft'));
    expect(keyIndex2('Shift')).toBe(keyIndex('ShiftRight'));
    expect(keyIndex('NoSuchKey')).toBe(-1);
  });

  it('round-trips bits through the packed words', () => {
    const words = new Uint32Array(8);
    writeKeyBit(words, keyIndex('KeyW'), true);
    writeKeyBit(words, 200, true);
    expect(readKeyBit(words, keyIndex('KeyW'))).toBe(true);
    expect(readKeyBit(words, 200)).toBe(true);
    expect(readKeyBit(words, keyIndex('KeyA'))).toBe(false);
    writeKeyBit(words, 200, false);
    expect(readKeyBit(words, 200)).toBe(false);
  });
});

describe('the input facade', () => {
  it('throws outside a guest call', () => {
    expect(() => input.isDown('W')).toThrow(/No gameable guest is running/);
  });

  it('decodes keys, edges, axes, mouse and gamepads', () => {
    const seen: Record<string, unknown> = {};
    const game = defineGame({
      systems: [
        (ctx) => {
          seen.down = ctx.input.isDown('W');
          seen.pressed = ctx.input.pressed('W');
          seen.releasedA = ctx.input.released('A');
          seen.shift = ctx.input.isDown('Shift');
          const axis = ctx.input.axis2('A', 'D', 'S', 'W');
          seen.axisX = axis.x;
          seen.axisY = axis.y;
          seen.mouseDown = ctx.input.mouseDown(MOUSE_BUTTONS.LEFT);
          seen.mousePressed = ctx.input.mousePressed(MOUSE_BUTTONS.RIGHT);
          seen.dx = ctx.input.mouse.dx;
          seen.pad = ctx.input.gamepad(0)?.axes[0];
          seen.missingPad = ctx.input.gamepad(3);
          seen.focused = ctx.input.focused;
        },
      ],
    });
    const guest = createGuest(createStubHost(), game);
    guest.init(stubConfig());

    const state = stubInput();
    hold(state, 'W');
    hold(state, 'D');
    hold(state, 'ShiftRight');
    writeKeyBit(state.keys.released, keyIndex('KeyA'), true);
    state.mouse.buttons = MOUSE_BUTTONS.LEFT;
    state.mouse.pressed = MOUSE_BUTTONS.RIGHT;
    state.mouse.dx = 12.5;
    state.gamepads = [
      {
        index: 0,
        connected: true,
        buttons: 1,
        pressed: 1,
        released: 0,
        axes: [0.25, 0, 0, 0, 0, 0],
      },
    ];

    guest.tick(stubFrame(0, state));

    expect(seen.down).toBe(true);
    expect(seen.pressed).toBe(true);
    expect(seen.releasedA).toBe(true);
    // `Shift` covers both physical keys.
    expect(seen.shift).toBe(true);
    expect(seen.axisX).toBe(1);
    expect(seen.axisY).toBe(1);
    expect(seen.mouseDown).toBe(true);
    expect(seen.mousePressed).toBe(true);
    expect(seen.dx).toBe(12.5);
    expect(seen.pad).toBe(0.25);
    expect(seen.missingPad).toBeNull();
    expect(seen.focused).toBe(true);
  });

  it('copies the incoming bitsets instead of aliasing them', () => {
    let observed = false;
    const game = defineGame({
      systems: [
        (ctx) => {
          observed = ctx.input.isDown('W');
        },
      ],
    });
    const guest = createGuest(createStubHost(), game);
    guest.init(stubConfig());

    const state = stubInput();
    hold(state, 'W');
    guest.tick(stubFrame(0, state));
    expect(observed).toBe(true);

    // The host reuses its state object; clearing it must be visible next tick.
    state.keys.down.fill(0);
    guest.tick(stubFrame(1, state));
    expect(observed).toBe(false);
  });
});
