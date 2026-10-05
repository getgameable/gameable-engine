/**
 * `gameable/input` — keyboard, mouse, pointer lock and gamepad, packed into
 * the WIT `input-state` block and read through named actions.
 *
 * The pipeline is three layers, each usable on its own:
 *
 * 1. {@link createInputCapture} attaches DOM listeners and fills an
 *    {@link InputState} once per frame.
 * 2. {@link InputState} is the packed frame block: three 256-bit key bitsets,
 *    modifier flags, mouse, gamepads. Read it with {@link isDown},
 *    {@link wasPressed}, {@link wasReleased} and {@link axis2}.
 * 3. {@link createActionMap} resolves names like `fire` and `move` to
 *    bindings, so gameplay never mentions a key code.
 *
 * {@link input} wires all three into an `EngineModule`.
 */
export {
  GAMEPAD_BUTTON_INDEX,
  gamepadButtonIndex,
  KEY_COUNT,
  KEY_INDEX,
  KEY_NAMES,
  KEY_WORDS,
  keyIndex,
  keyIndex2,
  POINTER_BASE,
  POINTER_BUTTON_MAX,
  pointerKeyIndex,
} from './keycodes';

export {
  axis2,
  clearEdges,
  createInputState,
  DEFAULT_GAMEPAD_SLOTS,
  GAMEPAD_AXES,
  isDown,
  Mods,
  MouseButtons,
  resetInputState,
  setBit,
  wasPressed,
  wasReleased,
  type GamepadState,
  type InputState,
  type MouseState,
} from './state';

export { createInputCapture, type InputCapture, type InputCaptureOptions } from './capture';

export {
  createActionMap,
  type ActionBindings,
  type ActionMap,
  type ActionRef,
  type ActionSpec,
  type Axis2Spec,
} from './actions';

export { input, type InputModule, type InputOptions, type InputService } from './module';

import type { InputService } from './module';

/*
 * Merge the input service into the engine's typed service table, so
 * `engine.get('input')` is an `InputService` with no cast at the call site.
 * Importing this package is enough: the merge is global.
 */
declare module '@gameable/core' {
  interface EngineServices {
    /** The input service, published by the `'input'` module. */
    input: InputService;
  }
}

/**
 * Package identity marker for `gameable/input`.
 *
 * @example
 * ```ts
 * import { PACKAGE } from 'gameable/input';
 *
 * console.log(PACKAGE); // 'gameable/input'
 * ```
 */
export const PACKAGE = '@gameable/input' as const;
