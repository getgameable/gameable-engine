/**
 * The packed per-frame input block and the pure helpers that read it.
 *
 * The shape mirrors `input-state` in `wit/types.wit` one field at a time, so
 * the host can hand it to the wasm guest without a translation layer:
 * `key-state` becomes three `Uint32Array(8)` bitsets, `input-mods` becomes the
 * {@link Mods} bit flags, `mouse-state` and `gamepad-state` become plain
 * objects with typed-array axes.
 *
 * Every object here is allocated once, by {@link createInputState}, and then
 * mutated in place for the lifetime of the run. Nothing in this file
 * allocates.
 */
import { KEY_WORDS } from './keycodes';

/**
 * Keyboard modifier bits, in `input-mods` flag order.
 *
 * @example
 * ```ts
 * import { createInputState, Mods } from 'gameable/input';
 *
 * const state = createInputState();
 * state.mods = Mods.Shift | Mods.Ctrl;
 * console.log((state.mods & Mods.Shift) !== 0); // true
 * ```
 */
export const Mods = Object.freeze({
  /** Either shift key is held. */
  Shift: 1 << 0,
  /** Either control key is held. */
  Ctrl: 1 << 1,
  /** Either alt / option key is held. */
  Alt: 1 << 2,
  /** Either meta / command / windows key is held. */
  Meta: 1 << 3,
  /** Caps lock is on. */
  CapsLock: 1 << 4,
  /** Num lock is on. */
  NumLock: 1 << 5,
});

/**
 * Mouse button bits, matching `mouse-state.buttons` in the WIT contract and
 * the DOM `MouseEvent.button` numbering.
 *
 * @example
 * ```ts
 * import { createInputState, MouseButtons } from 'gameable/input';
 *
 * const state = createInputState();
 * state.mouse.buttons = MouseButtons.Left;
 * console.log((state.mouse.buttons & MouseButtons.Left) !== 0); // true
 * ```
 */
export const MouseButtons = Object.freeze({
  /** Left button. */
  Left: 1 << 0,
  /** Middle button, usually the wheel. */
  Middle: 1 << 1,
  /** Right button. */
  Right: 1 << 2,
  /** Fourth button, "back" on most mice. */
  Back: 1 << 3,
  /** Fifth button, "forward" on most mice. */
  Forward: 1 << 4,
});

/** Number of axes a {@link GamepadState} carries: lx, ly, rx, ry, lt, rt. */
export const GAMEPAD_AXES = 6;

/**
 * Pointer state for one frame. `dx`/`dy` are the frame's accumulated movement:
 * `movementX`/`movementY` while pointer lock is held, the client-space
 * difference otherwise.
 *
 * @example
 * ```ts
 * import { createInputState } from 'gameable/input';
 *
 * const { mouse } = createInputState();
 * console.log(mouse.x, mouse.dx, mouse.locked); // 0 0 false
 * ```
 */
export interface MouseState {
  /** Client-space X in CSS pixels. */
  x: number;
  /** Client-space Y in CSS pixels. */
  y: number;
  /** Accumulated X movement for the frame. */
  dx: number;
  /** Accumulated Y movement for the frame. */
  dy: number;
  /** Accumulated wheel delta for the frame, in lines; positive is down. */
  wheel: number;
  /** Buttons held, as {@link MouseButtons} bits. */
  buttons: number;
  /** Buttons that went down this frame. */
  pressed: number;
  /** Buttons that came up this frame. */
  released: number;
  /** Pointer lock is currently held by the capture target. */
  locked: boolean;
}

/**
 * One gamepad slot. Slots are preallocated and reused; read `connected` before
 * trusting `buttons` or `axes`.
 *
 * @example
 * ```ts
 * import { createInputState } from 'gameable/input';
 *
 * const pad = createInputState().gamepads[0];
 * console.log(pad.index, pad.connected, pad.axes.length); // 0 false 6
 * ```
 */
export interface GamepadState {
  /** `navigator.getGamepads()` slot this state mirrors. */
  index: number;
  /** A pad is present in this slot. */
  connected: boolean;
  /** Standard-mapping buttons held, one bit per button index. */
  buttons: number;
  /** Buttons that went down this frame. */
  pressed: number;
  /** Buttons that came up this frame. */
  released: number;
  /** Standard mapping: lx, ly, rx, ry, left trigger, right trigger. */
  axes: Float32Array;
}

/**
 * The whole input block for one frame: the packed form of WIT `input-state`.
 *
 * @example
 * ```ts
 * import { createInputState, isDown, keyIndex } from 'gameable/input';
 *
 * const state = createInputState();
 * console.log(state.keysDown.length, isDown(state, keyIndex('W'))); // 8 false
 * ```
 */
export interface InputState {
  /** Keys held this frame, 256 bits in 8 words. */
  keysDown: Uint32Array;
  /** Keys that went down this frame. */
  keysPressed: Uint32Array;
  /** Keys that came up this frame. */
  keysReleased: Uint32Array;
  /** Modifier flags, as {@link Mods} bits. */
  mods: number;
  /** Pointer state. */
  mouse: MouseState;
  /** Gamepad slots, preallocated and stable. */
  gamepads: GamepadState[];
  /** The capture target has focus; treat input as neutral when false. */
  focused: boolean;
}

/** Default number of preallocated gamepad slots. */
export const DEFAULT_GAMEPAD_SLOTS = 4;

/**
 * Allocate a zeroed {@link InputState}. This is the only allocation the input
 * pipeline performs; everything afterwards mutates it in place.
 *
 * @param gamepadSlots How many gamepad slots to preallocate.
 *
 * @returns A fresh, neutral input state.
 *
 * @example
 * ```ts
 * import { createInputState } from 'gameable/input';
 *
 * const state = createInputState();
 * console.log(state.gamepads.length, state.focused); // 4 false
 * ```
 */
export function createInputState(gamepadSlots = DEFAULT_GAMEPAD_SLOTS): InputState {
  const gamepads: GamepadState[] = [];
  for (let i = 0; i < gamepadSlots; i += 1) {
    gamepads.push({
      index: i,
      connected: false,
      buttons: 0,
      pressed: 0,
      released: 0,
      axes: new Float32Array(GAMEPAD_AXES),
    });
  }
  return {
    keysDown: new Uint32Array(KEY_WORDS),
    keysPressed: new Uint32Array(KEY_WORDS),
    keysReleased: new Uint32Array(KEY_WORDS),
    mods: 0,
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
    gamepads,
    focused: false,
  };
}

/**
 * Is the key at `index` held this frame?
 *
 * A negative index (what {@link keyIndex} returns for an unknown name) is
 * always false, so an unresolvable binding is dead rather than fatal.
 *
 * @param state The state to read.
 * @param index A frozen key index.
 *
 * @returns True when the key is down.
 *
 * @example
 * ```ts
 * import { createInputState, isDown, keyIndex } from 'gameable/input';
 *
 * const state = createInputState();
 * state.keysDown[keyIndex('W') >> 5] |= 1 << (keyIndex('W') & 31);
 * console.log(isDown(state, keyIndex('W'))); // true
 * ```
 */
export function isDown(state: InputState, index: number): boolean {
  return readBit(state.keysDown, index);
}

/**
 * Did the key at `index` go down this frame?
 *
 * @param state The state to read.
 * @param index A frozen key index.
 *
 * @returns True on the single frame the key went down.
 *
 * @example
 * ```ts
 * import { createInputState, keyIndex, wasPressed } from 'gameable/input';
 *
 * const state = createInputState();
 * console.log(wasPressed(state, keyIndex('Space'))); // false
 * ```
 */
export function wasPressed(state: InputState, index: number): boolean {
  return readBit(state.keysPressed, index);
}

/**
 * Did the key at `index` come up this frame?
 *
 * @param state The state to read.
 * @param index A frozen key index.
 *
 * @returns True on the single frame the key came up.
 *
 * @example
 * ```ts
 * import { createInputState, keyIndex, wasReleased } from 'gameable/input';
 *
 * const state = createInputState();
 * console.log(wasReleased(state, keyIndex('Space'))); // false
 * ```
 */
export function wasReleased(state: InputState, index: number): boolean {
  return readBit(state.keysReleased, index);
}

/**
 * Read one bit out of a packed 256-bit key bitset.
 *
 * @param words The eight-word bitset.
 * @param index Bit index; out-of-range indexes read as false.
 *
 * @returns The bit, as a boolean.
 */
function readBit(words: Uint32Array, index: number): boolean {
  if (index < 0 || index >= KEY_WORDS * 32) return false;
  return (words[index >> 5] & (1 << (index & 31))) !== 0;
}

/**
 * Set or clear one bit in a packed key bitset. Exported for capture and for
 * tests that hand-build a state; game code reads, it does not write.
 *
 * @param words The eight-word bitset.
 * @param index Bit index; out-of-range indexes are ignored.
 * @param value True to set the bit, false to clear it.
 *
 * @example
 * ```ts
 * import { createInputState, isDown, keyIndex, setBit } from 'gameable/input';
 *
 * const state = createInputState();
 * setBit(state.keysDown, keyIndex('KeyA'), true);
 * console.log(isDown(state, keyIndex('KeyA'))); // true
 * ```
 */
export function setBit(words: Uint32Array, index: number, value: boolean): void {
  if (index < 0 || index >= KEY_WORDS * 32) return;
  const word = index >> 5;
  const bit = 1 << (index & 31);
  if (value) words[word] |= bit;
  else words[word] &= ~bit;
}

/** Scratch tuple returned by {@link axis2} when the caller passes no `out`. */
const AXIS2_SCRATCH: [number, number] = [0, 0];

/**
 * Read four keys as one clamped 2D axis: `x = posX - negX`, `y = posY - negY`.
 *
 * The result is written into a **reusable** tuple. Consume it before the next
 * call, or pass your own `out` — this keeps the per-frame allocation count at
 * zero, which hard rule 2 requires of anything on the update path.
 *
 * @param state The state to read.
 * @param negX Key index driving -X, e.g. `keyIndex('A')`.
 * @param posX Key index driving +X, e.g. `keyIndex('D')`.
 * @param negY Key index driving -Y, e.g. `keyIndex('S')`.
 * @param posY Key index driving +Y, e.g. `keyIndex('W')`.
 * @param out Tuple to write into; defaults to a shared scratch tuple.
 *
 * @returns `out`, holding the axis values, each in -1..1.
 *
 * @example
 * ```ts
 * import { axis2, createInputState, keyIndex, setBit } from 'gameable/input';
 *
 * const state = createInputState();
 * setBit(state.keysDown, keyIndex('W'), true);
 * const [x, y] = axis2(state, keyIndex('A'), keyIndex('D'), keyIndex('S'), keyIndex('W'));
 * console.log(x, y); // 0 1
 * ```
 */
export function axis2(
  state: InputState,
  negX: number,
  posX: number,
  negY: number,
  posY: number,
  out: [number, number] = AXIS2_SCRATCH,
): [number, number] {
  out[0] = (isDown(state, posX) ? 1 : 0) - (isDown(state, negX) ? 1 : 0);
  out[1] = (isDown(state, posY) ? 1 : 0) - (isDown(state, negY) ? 1 : 0);
  return out;
}

/**
 * Clear every single-frame edge: key press/release bitsets, mouse edges and
 * deltas, gamepad edges. The loop calls this from `endFrame`.
 *
 * @param state The state to clear, in place.
 *
 * @example
 * ```ts
 * import { clearEdges, createInputState } from 'gameable/input';
 *
 * const state = createInputState();
 * state.mouse.dx = 12;
 * clearEdges(state);
 * console.log(state.mouse.dx); // 0
 * ```
 */
export function clearEdges(state: InputState): void {
  state.keysPressed.fill(0);
  state.keysReleased.fill(0);
  const { mouse } = state;
  mouse.pressed = 0;
  mouse.released = 0;
  mouse.dx = 0;
  mouse.dy = 0;
  mouse.wheel = 0;
  for (const pad of state.gamepads) {
    pad.pressed = 0;
    pad.released = 0;
  }
}

/**
 * Return the state to neutral: nothing held, no edges, no deltas. Capture
 * calls this on `blur` so a key held when the window loses focus does not
 * stick down forever.
 *
 * @param state The state to reset, in place.
 *
 * @example
 * ```ts
 * import { createInputState, isDown, keyIndex, resetInputState, setBit } from 'gameable/input';
 *
 * const state = createInputState();
 * setBit(state.keysDown, keyIndex('W'), true);
 * resetInputState(state);
 * console.log(isDown(state, keyIndex('W'))); // false
 * ```
 */
export function resetInputState(state: InputState): void {
  state.keysDown.fill(0);
  state.mods = 0;
  state.mouse.buttons = 0;
  clearEdges(state);
  for (const pad of state.gamepads) {
    pad.buttons = 0;
    pad.axes.fill(0);
  }
}
