// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createInputCapture, type InputCapture } from './capture';
import { keyIndex } from './keycodes';
import { isDown, Mods, MouseButtons, wasPressed, wasReleased } from './state';

/** Captures created by a test, disposed afterwards. */
const open: InputCapture[] = [];

/**
 * Create a capture on the window and register it for disposal.
 *
 * @param options Capture options.
 *
 * @returns The capture.
 */
function capture(options: Parameters<typeof createInputCapture>[1] = {}): InputCapture {
  const made = createInputCapture(window, options);
  open.push(made);
  return made;
}

/**
 * Dispatch a keyboard event on the window.
 *
 * @param type `keydown` or `keyup`.
 * @param code A `KeyboardEvent.code`.
 * @param init Extra event fields, e.g. `{ shiftKey: true }`.
 *
 * @returns The dispatched event, so a test can inspect `defaultPrevented`.
 */
function key(type: 'keydown' | 'keyup', code: string, init: KeyboardEventInit = {}): KeyboardEvent {
  const event = new KeyboardEvent(type, { code, bubbles: true, cancelable: true, ...init });
  window.dispatchEvent(event);
  return event;
}

/**
 * Dispatch a mouse event on the window.
 *
 * @param type The event type.
 * @param init Event fields.
 */
function mouse(type: 'mousemove' | 'mousedown' | 'mouseup', init: MouseEventInit = {}): void {
  window.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, ...init }));
}

afterEach(() => {
  for (const made of open.splice(0)) made.dispose();
});

describe('keyboard capture', () => {
  it.each(['input', 'textarea', 'select', 'editable'])(
    'keeps typing in %s out of gameplay keys and modifiers',
    (kind) => {
      const input = capture({ focused: true });
      const field = document.createElement(kind === 'editable' ? 'div' : kind);
      const target = kind === 'editable' ? document.createElement('span') : field;
      if (kind === 'editable') {
        field.setAttribute('contenteditable', 'true');
        field.append(target);
      }
      document.body.append(field);
      try {
        for (const type of ['keydown', 'keyup']) {
          const event = new KeyboardEvent(type, {
            code: 'KeyW',
            shiftKey: true,
            bubbles: true,
            cancelable: true,
          });
          target.dispatchEvent(event);
          expect(event.defaultPrevented).toBe(false);
          input.beginFrame();
          input.consume();
          expect(isDown(input.state, keyIndex('W'))).toBe(false);
          expect(wasPressed(input.state, keyIndex('W'))).toBe(false);
          expect(wasReleased(input.state, keyIndex('W'))).toBe(false);
          expect(input.state.mods).toBe(0);
          input.endFrame();
        }
      } finally {
        field.remove();
      }
    },
  );

  it('releases held movement and pending actions on field focus, then resumes on fresh gameplay input', () => {
    const input = capture({ focused: true });
    const field = document.createElement('input');
    document.body.append(field);
    try {
      key('keydown', 'KeyW');
      input.beginFrame();
      input.consume();
      input.endFrame();
      key('keydown', 'Space');
      input.beginFrame();
      input.endFrame();
      field.focus();
      input.beginFrame();
      input.consume();
      expect(isDown(input.state, keyIndex('W'))).toBe(false);
      expect(wasReleased(input.state, keyIndex('W'))).toBe(true);
      expect(wasPressed(input.state, keyIndex('Space'))).toBe(false);
      expect(input.state.focused).toBe(true);
      input.endFrame();
      field.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyW', bubbles: true }));
      field.blur();
      key('keydown', 'KeyW');
      input.beginFrame();
      input.consume();
      expect(isDown(input.state, keyIndex('W'))).toBe(true);
      expect(wasPressed(input.state, keyIndex('W'))).toBe(true);
    } finally {
      field.remove();
    }
  });
  it('reports down, pressed and released on the right frames', () => {
    const input = capture();
    const w = keyIndex('W');

    key('keydown', 'KeyW');
    input.beginFrame();
    input.consume();
    expect(isDown(input.state, w)).toBe(true);
    expect(wasPressed(input.state, w)).toBe(true);
    expect(wasReleased(input.state, w)).toBe(false);
    input.endFrame();

    // Still held: no new edge.
    input.beginFrame();
    input.consume();
    expect(isDown(input.state, w)).toBe(true);
    expect(wasPressed(input.state, w)).toBe(false);
    input.endFrame();

    key('keyup', 'KeyW');
    input.beginFrame();
    input.consume();
    expect(isDown(input.state, w)).toBe(false);
    expect(wasReleased(input.state, w)).toBe(true);
    input.endFrame();

    input.beginFrame();
    input.consume();
    expect(wasReleased(input.state, w)).toBe(false);
    input.endFrame();
  });

  it('keeps a tap that happens entirely inside one frame', () => {
    const input = capture();
    key('keydown', 'Space');
    key('keyup', 'Space');

    input.beginFrame();
    input.consume();
    expect(wasPressed(input.state, keyIndex('Space'))).toBe(true);
    expect(wasReleased(input.state, keyIndex('Space'))).toBe(true);
    expect(isDown(input.state, keyIndex('Space'))).toBe(false);
    input.endFrame();
  });

  it('does not turn auto-repeat into new presses', () => {
    const input = capture();
    key('keydown', 'KeyW');
    input.beginFrame();
    input.consume();
    input.endFrame();

    key('keydown', 'KeyW', { repeat: true });
    input.beginFrame();
    input.consume();
    expect(isDown(input.state, keyIndex('W'))).toBe(true);
    expect(wasPressed(input.state, keyIndex('W'))).toBe(false);
    input.endFrame();
  });

  it('ignores codes that are not in the table', () => {
    const input = capture();
    expect(() => {
      key('keydown', 'Lang1');
    }).not.toThrow();
    input.beginFrame();
    expect([...input.state.keysDown].every((word) => word === 0)).toBe(true);
  });

  it('packs modifier flags', () => {
    const input = capture();
    key('keydown', 'ShiftLeft', { shiftKey: true, ctrlKey: true });
    input.beginFrame();
    expect(input.state.mods & Mods.Shift).toBeTruthy();
    expect(input.state.mods & Mods.Ctrl).toBeTruthy();
    expect(input.state.mods & Mods.Alt).toBe(0);
  });

  it('suppresses the scroll keys while focused, but never escape or F5', () => {
    // jsdom's `document.hasFocus()` is false for a document nobody clicked, so
    // the capture would otherwise start unfocused and suppress nothing.
    const input = capture({ focused: true });
    expect(key('keydown', 'Space').defaultPrevented).toBe(true);
    expect(key('keydown', 'ArrowDown').defaultPrevented).toBe(true);
    expect(key('keydown', 'KeyW').defaultPrevented).toBe(false);
    expect(key('keydown', 'Escape').defaultPrevented).toBe(false);
    expect(key('keydown', 'F5').defaultPrevented).toBe(false);
    // Browser shortcuts still reach the browser.
    expect(key('keydown', 'Space', { ctrlKey: true }).defaultPrevented).toBe(false);
    input.beginFrame();
  });

  it('never suppresses keys typed into a field', () => {
    const input = capture({ focused: true });
    const field = document.createElement('input');
    document.body.append(field);
    const event = new KeyboardEvent('keydown', { code: 'Space', bubbles: true, cancelable: true });
    field.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
    field.remove();
    input.beginFrame();
  });

  it('can be told not to preventDefault at all', () => {
    const input = capture({ preventDefault: false, focused: true });
    expect(key('keydown', 'Space').defaultPrevented).toBe(false);
    input.beginFrame();
  });

  it('drops everything held when the window blurs', () => {
    const input = capture();
    key('keydown', 'KeyW');
    input.beginFrame();
    input.consume();
    input.endFrame();

    window.dispatchEvent(new Event('blur'));
    input.beginFrame();
    input.consume();
    expect(input.state.focused).toBe(false);
    expect(isDown(input.state, keyIndex('W'))).toBe(false);
    expect(wasReleased(input.state, keyIndex('W'))).toBe(true);
    input.endFrame();

    window.dispatchEvent(new Event('focus'));
    input.beginFrame();
    expect(input.state.focused).toBe(true);
  });

  it('seeds focused from the document and honours the override', () => {
    // jsdom reports an unfocused document, which is exactly the case the
    // option exists for.
    const seeded = capture();
    seeded.beginFrame();
    expect(seeded.state.focused).toBe(document.hasFocus());

    const forced = capture({ focused: true });
    forced.beginFrame();
    expect(forced.state.focused).toBe(true);
  });

  it('skips the fold on an idle frame but still observes a blur', () => {
    const input = capture({ focused: true });
    key('keydown', 'KeyW');
    input.beginFrame();
    input.consume();
    expect(isDown(input.state, keyIndex('W'))).toBe(true);
    input.endFrame();

    // Nothing happened: the fold is skipped and the published level state is
    // unchanged, which is what makes skipping safe.
    for (let i = 0; i < 5; i += 1) {
      input.beginFrame();
      input.consume();
      expect(isDown(input.state, keyIndex('W'))).toBe(true);
      expect(wasPressed(input.state, keyIndex('W'))).toBe(false);
      input.endFrame();
    }

    // A blur is a handler, so it dirties the capture and the next fold runs.
    window.dispatchEvent(new Event('blur'));
    input.beginFrame();
    input.consume();
    expect(input.state.focused).toBe(false);
    expect(isDown(input.state, keyIndex('W'))).toBe(false);
    expect(wasReleased(input.state, keyIndex('W'))).toBe(true);
  });
});

describe('pointer lock denial', () => {
  it('reports a pointerlockerror through the flag and the callback', () => {
    const element = document.createElement('canvas');
    document.body.append(element);
    const denied = vi.fn();
    Object.defineProperty(element, 'requestPointerLock', {
      configurable: true,
      value: (): void => undefined,
    });

    const input = createInputCapture(element, { pointerLock: true, onLockDenied: denied });
    open.push(input);
    expect(input.lockDenied).toBe(false);

    input.requestPointerLock();
    document.dispatchEvent(new Event('pointerlockerror'));
    expect(input.lockDenied).toBe(true);
    expect(denied).toHaveBeenCalledTimes(1);

    // Asking again clears the flag; getting the lock keeps it clear.
    input.requestPointerLock();
    expect(input.lockDenied).toBe(false);
    element.remove();
  });

  it('reports a rejected requestPointerLock promise', async () => {
    const element = document.createElement('canvas');
    document.body.append(element);
    Object.defineProperty(element, 'requestPointerLock', {
      configurable: true,
      value: (): Promise<void> => Promise.reject(new Error('needs a user gesture')),
    });

    const input = createInputCapture(element, { pointerLock: true });
    open.push(input);
    input.requestPointerLock();
    await Promise.resolve();
    await Promise.resolve();
    expect(input.lockDenied).toBe(true);
    element.remove();
  });
});

describe('mouse capture', () => {
  it('accumulates absolute motion into a per-frame delta', () => {
    const input = capture();
    mouse('mousemove', { clientX: 100, clientY: 100 });
    mouse('mousemove', { clientX: 110, clientY: 95 });
    mouse('mousemove', { clientX: 115, clientY: 95 });

    input.beginFrame();
    input.consume();
    expect(input.state.mouse.x).toBe(115);
    expect(input.state.mouse.y).toBe(95);
    expect(input.state.mouse.dx).toBe(15);
    expect(input.state.mouse.dy).toBe(-5);
    input.endFrame();

    // The delta was consumed; the position survives.
    input.beginFrame();
    input.consume();
    expect(input.state.mouse.dx).toBe(0);
    expect(input.state.mouse.x).toBe(115);
  });

  it('reports button edges and mirrors them into the key bitset', () => {
    const input = capture();
    mouse('mousedown', { button: 0 });
    input.beginFrame();
    input.consume();
    expect(input.state.mouse.buttons).toBe(MouseButtons.Left);
    expect(input.state.mouse.pressed).toBe(MouseButtons.Left);
    expect(isDown(input.state, keyIndex('LMB'))).toBe(true);
    expect(wasPressed(input.state, keyIndex('LMB'))).toBe(true);
    input.endFrame();

    mouse('mouseup', { button: 0 });
    input.beginFrame();
    input.consume();
    expect(input.state.mouse.buttons).toBe(0);
    expect(input.state.mouse.released).toBe(MouseButtons.Left);
    expect(wasReleased(input.state, keyIndex('LMB'))).toBe(true);
  });

  it('normalises wheel deltas to lines and accumulates them', () => {
    const input = capture();
    window.dispatchEvent(new WheelEvent('wheel', { deltaY: 100, deltaMode: 0, bubbles: true }));
    window.dispatchEvent(new WheelEvent('wheel', { deltaY: 50, deltaMode: 0, bubbles: true }));
    input.beginFrame();
    input.consume();
    expect(input.state.mouse.wheel).toBeCloseTo(1.5, 5);
    input.endFrame();

    window.dispatchEvent(new WheelEvent('wheel', { deltaY: -2, deltaMode: 1, bubbles: true }));
    input.beginFrame();
    input.consume();
    expect(input.state.mouse.wheel).toBe(-2);
  });

  it('suppresses the context menu', () => {
    const input = capture();
    const event = new Event('contextmenu', { bubbles: true, cancelable: true });
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    input.beginFrame();
  });
});

describe('pointer lock', () => {
  it('switches to movement deltas while locked', () => {
    const element = document.createElement('canvas');
    document.body.append(element);
    const input = createInputCapture(element, { pointerLock: true });
    open.push(input);

    // jsdom has no pointer lock; emulate the browser's bookkeeping.
    Object.defineProperty(document, 'pointerLockElement', {
      configurable: true,
      value: element,
    });
    document.dispatchEvent(new Event('pointerlockchange'));

    element.dispatchEvent(
      new MouseEvent('mousemove', { bubbles: true, clientX: 400, clientY: 400 }),
    );
    element.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 401 }));
    input.beginFrame();
    input.consume();
    expect(input.state.mouse.locked).toBe(true);
    // No movementX in the event, so the locked path contributes nothing —
    // the absolute path must not leak in.
    expect(input.state.mouse.dx).toBe(0);
    input.endFrame();

    Object.defineProperty(document, 'pointerLockElement', { configurable: true, value: null });
    document.dispatchEvent(new Event('pointerlockchange'));
    input.beginFrame();
    expect(input.state.mouse.locked).toBe(false);
    element.remove();
  });

  it('requests the lock on mousedown when asked to', () => {
    const element = document.createElement('canvas');
    document.body.append(element);
    const request = vi.fn();
    Object.defineProperty(element, 'requestPointerLock', { configurable: true, value: request });

    const input = createInputCapture(element, { pointerLock: true });
    open.push(input);
    element.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
    expect(request).toHaveBeenCalledTimes(1);

    input.requestPointerLock();
    expect(request).toHaveBeenCalledTimes(2);
    element.remove();
  });

  it('does not request the lock when pointerLock is off', () => {
    const element = document.createElement('canvas');
    document.body.append(element);
    const request = vi.fn();
    Object.defineProperty(element, 'requestPointerLock', { configurable: true, value: request });

    const input = createInputCapture(element);
    open.push(input);
    element.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
    expect(request).not.toHaveBeenCalled();
    element.remove();
  });
});

describe('gamepad polling', () => {
  it('packs buttons, edges and trigger axes once a pad connects', () => {
    const pad = {
      connected: true,
      buttons: Array.from({ length: 17 }, () => ({ pressed: false, value: 0 })),
      axes: [0, 0, 0, 0],
    };
    pad.buttons[0] = { pressed: true, value: 1 };
    pad.buttons[7] = { pressed: true, value: 0.75 };
    pad.axes[0] = 0.5;
    const getGamepads = vi.fn(() => [pad]);
    Object.defineProperty(navigator, 'getGamepads', { configurable: true, value: getGamepads });

    const input = capture();
    // Polling stays off until a pad announces itself.
    input.beginFrame();
    expect(getGamepads).not.toHaveBeenCalled();
    expect(input.state.gamepads[0].connected).toBe(false);
    input.endFrame();

    window.dispatchEvent(new Event('gamepadconnected'));
    input.beginFrame();
    input.consume();
    const slot = input.state.gamepads[0];
    expect(slot.connected).toBe(true);
    expect(slot.buttons).toBe((1 << 0) | (1 << 7));
    expect(slot.pressed).toBe((1 << 0) | (1 << 7));
    expect(slot.axes[0]).toBeCloseTo(0.5, 5);
    expect(slot.axes[5]).toBeCloseTo(0.75, 5); // right trigger from button 7
    input.endFrame();
    expect(slot.pressed).toBe(0);

    pad.buttons[0] = { pressed: false, value: 0 };
    input.beginFrame();
    input.consume();
    expect(slot.released).toBe(1 << 0);
    expect(slot.buttons).toBe(1 << 7);
  });
});

describe('edges survive until a fixed step consumes them', () => {
  /** Rendered frames drawn per fixed simulation step. */
  const FRAMES_PER_STEP = 10;

  it('delivers every press to exactly one fixed step at ten frames per step', () => {
    const input = capture();
    const e = keyIndex('KeyE');
    const taps = 30;
    let delivered = 0;

    for (let tap = 0; tap < taps; tap += 1) {
      // The tap lands on a different frame of each batch, so nothing here
      // relies on the press and the step happening to line up. Before the fix
      // only the tap that landed on the step's own frame was ever seen: about
      // one in ten here, and one in twenty-seven in headless Chromium.
      const on = tap % FRAMES_PER_STEP;
      for (let f = 0; f < FRAMES_PER_STEP; f += 1) {
        if (f === on) {
          key('keydown', 'KeyE');
          key('keyup', 'KeyE');
        }
        input.beginFrame();
        if (f === FRAMES_PER_STEP - 1) {
          input.consume();
          if (wasPressed(input.state, e)) delivered += 1;
        }
        input.endFrame();
      }
    }

    expect(delivered).toBe(taps);
  });

  it('delivers a press to the first fixed step of a frame and no other', () => {
    const input = capture();
    const space = keyIndex('Space');
    key('keydown', 'Space');

    input.beginFrame();
    input.consume();
    expect(wasPressed(input.state, space)).toBe(true);
    input.consume();
    expect(wasPressed(input.state, space)).toBe(false);
    input.consume();
    expect(wasPressed(input.state, space)).toBe(false);
    input.endFrame();
  });

  it('loses nothing on a frame that runs no fixed step', () => {
    const input = capture();
    const e = keyIndex('KeyE');
    key('keydown', 'KeyE');
    key('keyup', 'KeyE');

    for (let i = 0; i < 12; i += 1) {
      input.beginFrame();
      input.endFrame();
    }

    input.beginFrame();
    input.consume();
    expect(wasPressed(input.state, e)).toBe(true);
    expect(wasReleased(input.state, e)).toBe(true);
    expect(isDown(input.state, e)).toBe(false);
    input.endFrame();
  });

  it('accumulates mouse deltas and wheel across unconsumed frames', () => {
    const input = capture();
    for (let i = 1; i <= 4; i += 1) {
      mouse('mousemove', { clientX: i * 10, clientY: 0 });
      window.dispatchEvent(new WheelEvent('wheel', { deltaY: 100, deltaMode: 0, bubbles: true }));
      input.beginFrame();
      input.endFrame();
    }

    input.beginFrame();
    input.consume();
    // The first move only establishes the origin, so three 10 px steps land.
    expect(input.state.mouse.dx).toBe(30);
    expect(input.state.mouse.wheel).toBeCloseTo(4, 5);
    input.endFrame();

    input.beginFrame();
    input.consume();
    expect(input.state.mouse.dx).toBe(0);
    expect(input.state.mouse.wheel).toBe(0);
    input.endFrame();
  });

  it('keeps both mouse-button edges of a click inside one unconsumed frame', () => {
    const input = capture();
    mouse('mousedown', { button: 0 });
    mouse('mouseup', { button: 0 });
    input.beginFrame();
    input.endFrame();
    input.beginFrame();
    input.endFrame();

    input.beginFrame();
    input.consume();
    expect(input.state.mouse.pressed).toBe(MouseButtons.Left);
    expect(input.state.mouse.released).toBe(MouseButtons.Left);
    expect(wasPressed(input.state, keyIndex('LMB'))).toBe(true);
    expect(wasReleased(input.state, keyIndex('LMB'))).toBe(true);
    input.endFrame();
  });

  it('holds gamepad button edges until a step consumes them', () => {
    const pad = {
      connected: true,
      buttons: Array.from({ length: 17 }, () => ({ pressed: false, value: 0 })),
      axes: [0, 0, 0, 0],
    };
    const getGamepads = vi.fn(() => [pad]);
    Object.defineProperty(navigator, 'getGamepads', { configurable: true, value: getGamepads });

    const input = capture();
    window.dispatchEvent(new Event('gamepadconnected'));
    input.beginFrame();
    input.consume();
    input.endFrame();

    // Pressed and released again, all inside frames that run no fixed step.
    pad.buttons[1] = { pressed: true, value: 1 };
    input.beginFrame();
    input.endFrame();
    pad.buttons[1] = { pressed: false, value: 0 };
    input.beginFrame();
    input.endFrame();

    input.beginFrame();
    input.consume();
    const slot = input.state.gamepads[0];
    expect(slot.pressed).toBe(1 << 1);
    expect(slot.released).toBe(1 << 1);
    input.endFrame();
  });
});

describe('dispose', () => {
  it('detaches every listener and clears the state', () => {
    const input = capture();
    key('keydown', 'KeyW');
    input.beginFrame();
    input.consume();
    expect(isDown(input.state, keyIndex('W'))).toBe(true);

    input.dispose();
    expect(isDown(input.state, keyIndex('W'))).toBe(false);

    key('keydown', 'KeyA');
    input.beginFrame();
    input.consume();
    expect(isDown(input.state, keyIndex('A'))).toBe(false);
  });
});

describe('allocation', () => {
  it('does not allocate in beginFrame, consume or endFrame', () => {
    const input = capture();
    const before = {
      keysDown: input.state.keysDown,
      mouse: input.state.mouse,
      pad: input.state.gamepads[0],
      axes: input.state.gamepads[0].axes,
    };
    for (let i = 0; i < 10; i += 1) {
      key('keydown', 'KeyW');
      mouse('mousemove', { clientX: i, clientY: i });
      input.beginFrame();
      input.consume();
      key('keyup', 'KeyW');
      input.endFrame();
    }
    expect(input.state.keysDown).toBe(before.keysDown);
    expect(input.state.mouse).toBe(before.mouse);
    expect(input.state.gamepads[0]).toBe(before.pad);
    expect(input.state.gamepads[0].axes).toBe(before.axes);
  });
});
