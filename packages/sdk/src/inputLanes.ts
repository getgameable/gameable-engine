/**
 * Input lanes: the preallocated storage one decoded `input-state` lands in.
 *
 * The runtime owns one set for `frame-input.input`, and every player slot in
 * `players.ts` owns another; both are filled by {@link copyInput}, so the local
 * player and a room's players decode identically.
 */
import { KEY_WORDS } from './keycodes';
import type { MutableGamepad } from './state';
import type { InputMods, InputState, MouseState } from './types';

/** Gamepads decoded per player per frame, as for `frame-input.input`. */
const MAX_GAMEPADS = 4;

/** Everything one decoded input owns: the runtime's own and every player slot. */
export interface InputLanes {
  keysDown: Uint32Array;
  keysPressed: Uint32Array;
  keysReleased: Uint32Array;
  mods: InputMods;
  mouse: MouseState;
  gamepads: MutableGamepad[];
  gamepadCount: number;
  focused: boolean;
}

/**
 * Copy one incoming `input-state` into preallocated lanes.
 *
 * @param to The lanes to overwrite.
 * @param src The incoming record; its lists are plain `Array`s in wasm mode.
 */
export function copyInput(to: InputLanes, src: InputState): void {
  const keys = src.keys;
  for (let i = 0; i < KEY_WORDS; i += 1) {
    to.keysDown[i] = keys.down[i] ?? 0;
    to.keysPressed[i] = keys.pressed[i] ?? 0;
    to.keysReleased[i] = keys.released[i] ?? 0;
  }
  const mods = to.mods;
  mods.shift = src.mods.shift;
  mods.ctrl = src.mods.ctrl;
  mods.alt = src.mods.alt;
  mods.meta = src.mods.meta;
  mods.capsLock = src.mods.capsLock;
  mods.numLock = src.mods.numLock;
  const m = src.mouse;
  const mouse = to.mouse;
  mouse.x = m.x;
  mouse.y = m.y;
  mouse.dx = m.dx;
  mouse.dy = m.dy;
  mouse.wheel = m.wheel;
  mouse.buttons = m.buttons;
  mouse.pressed = m.pressed;
  mouse.released = m.released;
  mouse.locked = m.locked;
  const pads = src.gamepads;
  const n = Math.min(pads.length, MAX_GAMEPADS);
  for (let i = 0; i < n; i += 1) {
    const from = pads[i];
    const pad = to.gamepads[i];
    pad.index = from.index;
    pad.connected = from.connected;
    pad.buttons = from.buttons;
    pad.pressed = from.pressed;
    pad.released = from.released;
    for (let a = 0; a < 6; a += 1) pad.axes[a] = from.axes[a] ?? 0;
  }
  to.gamepadCount = n;
  to.focused = src.focused;
}

/** Neutral lanes `clearLanes` copies from, built once. */
let neutral: InputLanes | null = null;

/**
 * Put lanes back to neutral, in place: nothing held, no mouse, no gamepads.
 *
 * @param to The lanes to clear.
 */
export function clearLanes(to: InputLanes): void {
  neutral ??= makeLanes();
  to.keysDown.fill(0);
  to.keysPressed.fill(0);
  to.keysReleased.fill(0);
  Object.assign(to.mods, neutral.mods);
  Object.assign(to.mouse, neutral.mouse);
  to.gamepadCount = 0;
  to.focused = true;
}

/**
 * @returns A zeroed, reusable gamepad snapshot.
 */
export function makeGamepad(): MutableGamepad {
  return {
    index: 0,
    connected: false,
    buttons: 0,
    pressed: 0,
    released: 0,
    axes: new Float32Array(6),
  };
}

/**
 * @returns Fresh, neutral input lanes.
 */
export function makeLanes(): InputLanes {
  return {
    keysDown: new Uint32Array(KEY_WORDS),
    keysPressed: new Uint32Array(KEY_WORDS),
    keysReleased: new Uint32Array(KEY_WORDS),
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
    gamepads: [makeGamepad(), makeGamepad(), makeGamepad(), makeGamepad()],
    gamepadCount: 0,
    focused: true,
  };
}
