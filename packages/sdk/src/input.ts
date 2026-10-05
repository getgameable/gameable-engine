/**
 * Keyboard, mouse and gamepad, decoded from `frame-input.input`.
 *
 * The host packs 256 key codes into eight `u32` words per edge. The SDK copies
 * those words into preallocated arrays once per tick (the incoming list is a
 * plain `Array` in wasm mode, so it cannot be aliased) and every query here is
 * a shift and a mask.
 */
import { keyIndex, keyIndex2, readKeyBit, type KeyName } from './keycodes';
import { requireRuntime } from './state';
import type { InputLanes } from './inputLanes';
import type { InputMods, MouseState } from './types';

/** Mouse button bit positions, matching `mouse-state.buttons`. */
export const MOUSE_BUTTONS = Object.freeze({
  /** Left button. */
  LEFT: 1,
  /** Right button. */
  RIGHT: 2,
  /** Middle button / wheel click. */
  MIDDLE: 4,
  /** Thumb "back" button. */
  BACK: 8,
  /** Thumb "forward" button. */
  FORWARD: 16,
});

/** A two-axis reading. Each facade returns its own object, the same one every call. */
export interface Axis2 {
  x: number;
  y: number;
}

const axisScratch: Axis2 = { x: 0, y: 0 };

/**
 * Read one key edge across a name that may cover a left/right pair.
 *
 * Not part of the public API.
 *
 * @param words The bitset to read.
 * @param name The key name.
 * @returns True when either bit is set.
 */
export function readKey(words: Uint32Array, name: KeyName): boolean {
  const a = keyIndex(name);
  if (a < 0) return false;
  if (readKeyBit(words, a)) return true;
  const b = keyIndex2(name);
  return b >= 0 && readKeyBit(words, b);
}

/**
 * Build an input facade over one set of lanes. Called once per lane set, never per tick.
 *
 * @param lanes Resolves the lanes to read: the runtime's own, or one player's slot.
 * @param scratch What `axis2` writes and returns; give each facade its own.
 * @returns The facade.
 */
export function createInputFacade(lanes: () => InputLanes, scratch: Axis2 = axisScratch) {
  return {
    /**
     * Is the key held this frame?
     *
     * @param key A DOM `code` (`'KeyW'`), a bare letter/digit (`'W'`, `'1'`) or
     *   an alias (`'Shift'`, `'Esc'`).
     * @returns True while the key is down.
     */
    isDown(key: KeyName): boolean {
      return readKey(lanes().keysDown, key);
    },

    /**
     * Did the key go down this frame?
     *
     * @param key A key name.
     * @returns True on the frame the key went down.
     */
    pressed(key: KeyName): boolean {
      return readKey(lanes().keysPressed, key);
    },

    /**
     * Did the key come up this frame?
     *
     * @param key A key name.
     * @returns True on the frame the key came up.
     */
    released(key: KeyName): boolean {
      return readKey(lanes().keysReleased, key);
    },

    /**
     * A two-axis reading built from four keys.
     *
     * @param negX Key that drives x negative, for example `'A'`.
     * @param posX Key that drives x positive, for example `'D'`.
     * @param negY Key that drives y negative, for example `'S'`.
     * @param posY Key that drives y positive, for example `'W'`.
     * @returns A pooled `{ x, y }` with components in -1..1. Never retain it.
     */
    axis2(negX: KeyName, posX: KeyName, negY: KeyName, posY: KeyName): Axis2 {
      const words = lanes().keysDown;
      scratch.x = (readKey(words, posX) ? 1 : 0) - (readKey(words, negX) ? 1 : 0);
      scratch.y = (readKey(words, posY) ? 1 : 0) - (readKey(words, negY) ? 1 : 0);
      return scratch;
    },

    /**
     * Keyboard modifier state.
     *
     * @returns The modifiers for this frame.
     */
    get mods(): InputMods {
      return lanes().mods;
    },

    /**
     * Pointer position, per-frame delta, wheel and button bitsets.
     *
     * @returns The mouse state for this frame. Owned by the SDK; never retain it.
     */
    get mouse(): MouseState {
      return lanes().mouse;
    },

    /**
     * Is a mouse button held?
     *
     * @param button A `MOUSE_BUTTONS` value, or a raw bit mask.
     * @returns True while the button is down.
     */
    mouseDown(button: number): boolean {
      return (lanes().mouse.buttons & button) !== 0;
    },

    /**
     * Did a mouse button go down this frame?
     *
     * @param button A `MOUSE_BUTTONS` value, or a raw bit mask.
     * @returns True on the frame the button went down.
     */
    mousePressed(button: number): boolean {
      return (lanes().mouse.pressed & button) !== 0;
    },

    /**
     * Did a mouse button come up this frame?
     *
     * @param button A `MOUSE_BUTTONS` value, or a raw bit mask.
     * @returns True on the frame the button came up.
     */
    mouseReleased(button: number): boolean {
      return (lanes().mouse.released & button) !== 0;
    },

    /**
     * One connected gamepad.
     *
     * @param index Navigator gamepad index.
     * @returns The gamepad, or `null` when nothing is connected at that index.
     *   Owned by the SDK; never retain it.
     */
    gamepad(index: number): {
      index: number;
      connected: boolean;
      buttons: number;
      pressed: number;
      released: number;
      axes: ArrayLike<number>;
    } | null {
      const l = lanes();
      for (let i = 0; i < l.gamepadCount; i += 1) {
        const pad = l.gamepads[i];
        if (pad.index === index) return pad;
      }
      return null;
    },

    /**
     * Does the canvas have focus? Treat input as neutral when it does not.
     *
     * @returns True while the canvas is focused.
     */
    get focused(): boolean {
      return lanes().focused;
    },
  };
}

/**
 * The keyboard, mouse and gamepad facade: the local player's input. That is
 * `frame-input.input` in a single-player game and on the authority, and the
 * local player's slot of `frame-input.players` on a client.
 *
 * @example
 * ```ts
 * import { input } from 'gameable';
 *
 * const move = input.axis2('A', 'D', 'S', 'W'); // x = strafe, y = forward
 * if (input.pressed('Space')) jump();
 * if (input.mouseDown(1)) fire();
 * ```
 */
export const input = createInputFacade(() => requireRuntime().inputLanes);
