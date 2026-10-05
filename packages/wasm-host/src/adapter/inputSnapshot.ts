/**
 * The input module's frame block, or a guest-shaped `InputState`, put into the
 * encoder's shape.
 */
import type { InputService } from '@gameable/input';
import { KEY_WORDS } from '@gameable/sdk';

import type { InputSnapshot } from '../encode-input';
import type { PlayerInput } from '../server/types';

/**
 * A zeroed snapshot, the one a host loop rewrites every fixed step.
 *
 * @returns A fresh snapshot.
 */
export function createInputSnapshot(): InputSnapshot {
  return {
    down: new Uint32Array(KEY_WORDS),
    pressed: new Uint32Array(KEY_WORDS),
    released: new Uint32Array(KEY_WORDS),
    mods: { shift: false, ctrl: false, alt: false, meta: false, capsLock: false, numLock: false },
    mouse: {
      x: 0,
      y: 0,
      dx: 0,
      dy: 0,
      wheel: 0,
      buttons: 0,
      pressed: 0,
      released: 0,
      locked: false,
    },
    gamepads: [],
    focused: true,
  };
}

/**
 * Copy the input module's state into the encoder's shape.
 *
 * The two differ in exactly two places: the key bitsets are named
 * `keysDown` / `keysPressed` / `keysReleased` rather than `down` / `pressed`
 * / `released`, and `mods` is a bitfield rather than a record.
 *
 * @param state The input module's published state.
 * @param snapshot The snapshot to rewrite.
 * @returns Nothing.
 */
export function copyInputState(state: InputService['state'], snapshot: InputSnapshot): void {
  snapshot.down = state.keysDown;
  snapshot.pressed = state.keysPressed;
  snapshot.released = state.keysReleased;
  const mods = state.mods;
  snapshot.mods.shift = (mods & 1) !== 0;
  snapshot.mods.ctrl = (mods & 2) !== 0;
  snapshot.mods.alt = (mods & 4) !== 0;
  snapshot.mods.meta = (mods & 8) !== 0;
  snapshot.mods.capsLock = (mods & 16) !== 0;
  snapshot.mods.numLock = (mods & 32) !== 0;
  const mouse = state.mouse;
  snapshot.mouse.x = mouse.x;
  snapshot.mouse.y = mouse.y;
  snapshot.mouse.dx = mouse.dx;
  snapshot.mouse.dy = mouse.dy;
  snapshot.mouse.wheel = mouse.wheel;
  snapshot.mouse.buttons = mouse.buttons;
  snapshot.mouse.pressed = mouse.pressed;
  snapshot.mouse.released = mouse.released;
  snapshot.mouse.locked = mouse.locked;
  snapshot.gamepads = state.gamepads;
  snapshot.focused = state.focused;
}

/**
 * Point a snapshot at a guest-shaped `InputState`, field by field.
 *
 * Nothing is copied: the key bitsets, `mods`, `mouse` and `gamepads` are
 * aliased, so the state must stay unchanged until the tick that reads the
 * snapshot has returned. This is how the server loop hands a remote player's
 * input to the encoder without allocating.
 *
 * @param state The input, in the WIT `input-state` shape.
 * @param snapshot The snapshot to rewrite.
 * @returns Nothing.
 */
export function aliasInputState(state: PlayerInput, snapshot: InputSnapshot): void {
  snapshot.down = state.keys.down;
  snapshot.pressed = state.keys.pressed;
  snapshot.released = state.keys.released;
  snapshot.mods = state.mods;
  snapshot.mouse = state.mouse;
  snapshot.gamepads = state.gamepads;
  snapshot.focused = state.focused;
}
