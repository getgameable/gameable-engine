/**
 * Named actions: the layer game code should read.
 *
 * A binding list is resolved **once**, at map creation, into frozen key
 * indexes and standard-mapping gamepad button numbers. Reading an action at
 * runtime is then a handful of bit tests — no string work, no allocation, on
 * the update path.
 *
 * Binding spellings are everything {@link keyIndex} accepts (`'KeyW'`, `'W'`,
 * `'Space'`, `'LMB'`, `'RMB'`) plus the `Gamepad*` names from
 * {@link GAMEPAD_BUTTON_INDEX} (`'GamepadA'`, `'GamepadRT'`).
 */
import { gamepadButtonIndex, keyIndex, keyIndex2 } from './keycodes';
import { isDown, wasPressed, wasReleased, type GamepadState, type InputState } from './state';

/**
 * A two-axis action: four buttons, and optionally a gamepad stick.
 *
 * @example
 * ```ts
 * import { type Axis2Spec } from 'gameable/input';
 *
 * const move: Axis2Spec = { axis2: ['A', 'D', 'S', 'W'], gamepadAxes: [0, 1] };
 * console.log(move.axis2[3]); // 'W'
 * ```
 */
export interface Axis2Spec {
  /** Buttons driving `[-X, +X, -Y, +Y]`, e.g. `['A', 'D', 'S', 'W']`. */
  axis2: readonly [string, string, string, string];
  /** Gamepad axis indexes for `[x, y]`, e.g. `[0, 1]` for the left stick. */
  gamepadAxes?: readonly [number, number];
  /** Radial deadzone applied to the stick, 0..1. Default 0.15. */
  deadzone?: number;
  /**
   * Negate the gamepad Y axis so pushing the stick up matches `W`. Sticks
   * report +1 when pushed down, so this defaults to true.
   */
  invertGamepadY?: boolean;
}

/** One action's bindings: a button list, or a two-axis spec. */
export type ActionSpec = readonly string[] | Axis2Spec;

/**
 * The whole action map, as game code declares it.
 *
 * @example
 * ```ts
 * import { type ActionBindings } from 'gameable/input';
 *
 * const bindings: ActionBindings = {
 *   fire: ['LMB', 'GamepadRT'],
 *   move: { axis2: ['A', 'D', 'S', 'W'], gamepadAxes: [0, 1] },
 * };
 * console.log(Object.keys(bindings).length); // 2
 * ```
 */
export type ActionBindings = Readonly<Record<string, ActionSpec>>;

/**
 * How a reader names the action to read: the declared name, or the small
 * integer {@link ActionMap.handle} minted for it.
 *
 * Resolving a name costs a `Map` lookup and a branch; resolving a handle is an
 * array index. Hoist the handle out of the frame body and the read becomes a
 * handful of bit tests with no string work at all.
 *
 * @example
 * ```ts
 * import { createActionMap, createInputState, type ActionRef } from 'gameable/input';
 *
 * const actions = createActionMap({ jump: ['Space'] }, createInputState());
 * const jump: ActionRef = actions.handle('jump');
 * console.log(actions.down(jump)); // false
 * ```
 */
export type ActionRef = string | number;

/**
 * A resolved action map. Every method reads the bound state, or the state
 * passed explicitly as the last argument, and takes either an action name or
 * the handle {@link ActionMap.handle} returns.
 *
 * @example
 * ```ts
 * import { createActionMap, createInputState } from 'gameable/input';
 *
 * const actions = createActionMap({ jump: ['Space'] }, createInputState());
 * const jump = actions.handle('jump');
 * console.log(actions.down('jump'), actions.down(jump)); // false false
 * ```
 */
export interface ActionMap {
  /** Action names, in declaration order. */
  readonly names: readonly string[];
  /**
   * The stable handle for an action: its 1-based position in `names`.
   *
   * Resolve it once, at startup, and pass it to the readers instead of the
   * name. Unknown names throw here rather than sixty times a second.
   *
   * @param name The declared action name.
   *
   * @returns A small integer, `1..names.length`.
   */
  handle(name: string): number;
  /** Is any binding of this action held? */
  down(action: ActionRef, state?: InputState): boolean;
  /** Did any binding of this action go down this frame? */
  pressed(action: ActionRef, state?: InputState): boolean;
  /** Did any binding of this action come up this frame? */
  released(action: ActionRef, state?: InputState): boolean;
  /** Read a two-axis action into a reusable tuple. */
  axis2(action: ActionRef, state?: InputState, out?: [number, number]): [number, number];
  /** Point the map at a different state, e.g. a replayed one. */
  bind(state: InputState): void;
}

/** An action compiled to indexes. */
interface CompiledAction {
  /** Frozen key indexes, including the mirrored mouse buttons. */
  keys: number[];
  /** Standard-mapping gamepad button indexes. */
  padButtons: number[];
  /** Present when the action was declared as an {@link Axis2Spec}. */
  axis: CompiledAxis | null;
}

/** An {@link Axis2Spec} compiled to indexes. */
interface CompiledAxis {
  /** Key indexes for -X, +X, -Y, +Y. */
  keys: [number, number, number, number];
  /** Gamepad axis indexes, or null when the action is keys-only. */
  gamepadAxes: [number, number] | null;
  /** Radial deadzone, 0..1. */
  deadzone: number;
  /** Negate the gamepad Y axis. */
  invertY: boolean;
}

/** Default radial deadzone for a gamepad stick. */
const DEFAULT_DEADZONE = 0.15;

/** Scratch tuple for {@link ActionMap.axis2} callers that pass no `out`. */
const AXIS_SCRATCH: [number, number] = [0, 0];

/**
 * Compile a binding declaration into an {@link ActionMap}.
 *
 * Unknown binding spellings throw here, at startup, rather than silently
 * doing nothing sixty times a second.
 *
 * @param bindings The action declaration.
 * @param state State the map reads by default; may be supplied later with
 *   {@link ActionMap.bind} or per call.
 *
 * @returns The compiled map.
 *
 * @example
 * ```ts
 * import { createActionMap, createInputState, keyIndex, setBit } from 'gameable/input';
 *
 * const state = createInputState();
 * const actions = createActionMap(
 *   {
 *     fire: ['LMB', 'GamepadRT'],
 *     jump: ['Space', 'GamepadA'],
 *     move: { axis2: ['A', 'D', 'S', 'W'], gamepadAxes: [0, 1] },
 *   },
 *   state,
 * );
 * const move = actions.handle('move');
 *
 * setBit(state.keysDown, keyIndex('D'), true);
 * console.log(actions.axis2(move)); // [1, 0]
 * ```
 */
export function createActionMap(bindings: ActionBindings, state?: InputState): ActionMap {
  const compiled = new Map<string, CompiledAction>();
  const names: string[] = [];
  /** The same actions by handle: `byHandle[h - 1]` is `compiled.get(names[h - 1])`. */
  const byHandle: CompiledAction[] = [];
  for (const [name, spec] of Object.entries(bindings)) {
    const action = compile(name, spec);
    compiled.set(name, action);
    byHandle.push(action);
    names.push(name);
  }
  let bound = state;

  /**
   * Look up a compiled action by name or handle, or explain what was wrong.
   *
   * @param action The action name, or a handle from {@link ActionMap.handle}.
   *
   * @returns The compiled action.
   */
  const get = (action: ActionRef): CompiledAction => {
    if (typeof action === 'number') {
      const byIndex = byHandle[action - 1] as CompiledAction | undefined;
      if (!byIndex) {
        throw new Error(
          `unknown action handle ${String(action)}; handles run 1..${String(byHandle.length)}`,
        );
      }
      return byIndex;
    }
    const found = compiled.get(action);
    if (!found) {
      throw new Error(`unknown action "${action}"; declared actions are ${names.join(', ')}`);
    }
    return found;
  };

  /**
   * Resolve which state to read.
   *
   * @param given The per-call override, if any.
   *
   * @returns The state to read.
   */
  const pick = (given: InputState | undefined): InputState => {
    const resolved = given ?? bound;
    if (!resolved) throw new Error('action map has no input state; pass one or call bind()');
    return resolved;
  };

  // The three readers are deliberately three loops rather than one loop taking
  // a predicate: a shared `test(readKey)` is megamorphic at its call site, so
  // the engine cannot inline the bit test that is the entire body.

  /**
   * Is any binding of this action held?
   *
   * @param action The compiled action.
   * @param source The state to read.
   *
   * @returns True when any binding is down.
   */
  const testDown = (action: CompiledAction, source: InputState): boolean => {
    const { keys } = action;
    for (let i = 0; i < keys.length; i += 1) {
      if (isDown(source, keys[i])) return true;
    }
    const { padButtons } = action;
    for (let i = 0; i < padButtons.length; i += 1) {
      const mask = 1 << padButtons[i];
      for (const pad of source.gamepads) {
        if (pad.connected && (pad.buttons & mask) !== 0) return true;
      }
    }
    return false;
  };

  /**
   * Did any binding of this action go down this frame?
   *
   * @param action The compiled action.
   * @param source The state to read.
   *
   * @returns True when any binding has a press edge.
   */
  const testPressed = (action: CompiledAction, source: InputState): boolean => {
    const { keys } = action;
    for (let i = 0; i < keys.length; i += 1) {
      if (wasPressed(source, keys[i])) return true;
    }
    const { padButtons } = action;
    for (let i = 0; i < padButtons.length; i += 1) {
      const mask = 1 << padButtons[i];
      for (const pad of source.gamepads) {
        if (pad.connected && (pad.pressed & mask) !== 0) return true;
      }
    }
    return false;
  };

  /**
   * Did any binding of this action come up this frame?
   *
   * @param action The compiled action.
   * @param source The state to read.
   *
   * @returns True when any binding has a release edge.
   */
  const testReleased = (action: CompiledAction, source: InputState): boolean => {
    const { keys } = action;
    for (let i = 0; i < keys.length; i += 1) {
      if (wasReleased(source, keys[i])) return true;
    }
    const { padButtons } = action;
    for (let i = 0; i < padButtons.length; i += 1) {
      const mask = 1 << padButtons[i];
      for (const pad of source.gamepads) {
        if (pad.connected && (pad.released & mask) !== 0) return true;
      }
    }
    return false;
  };

  return {
    names,

    handle(name): number {
      const index = names.indexOf(name);
      if (index < 0) {
        throw new Error(`unknown action "${name}"; declared actions are ${names.join(', ')}`);
      }
      return index + 1;
    },

    down(action, override): boolean {
      return testDown(get(action), pick(override));
    },

    pressed(action, override): boolean {
      return testPressed(get(action), pick(override));
    },

    released(action, override): boolean {
      return testReleased(get(action), pick(override));
    },

    axis2(name, override, out = AXIS_SCRATCH): [number, number] {
      const action = get(name);
      const source = pick(override);
      const { axis } = action;
      if (!axis) {
        throw new Error(`action ${describe(name)} is not an axis2; declare it as { axis2: [...] }`);
      }
      const [negX, posX, negY, posY] = axis.keys;
      let x = (isDown(source, posX) ? 1 : 0) - (isDown(source, negX) ? 1 : 0);
      let y = (isDown(source, posY) ? 1 : 0) - (isDown(source, negY) ? 1 : 0);
      if (axis.gamepadAxes) {
        const pad = firstConnected(source.gamepads);
        if (pad) {
          const [ix, iy] = axis.gamepadAxes;
          const gx = ix < pad.axes.length ? pad.axes[ix] : 0;
          const gyRaw = iy < pad.axes.length ? pad.axes[iy] : 0;
          const gy = axis.invertY ? -gyRaw : gyRaw;
          const magnitude = Math.hypot(gx, gy);
          if (magnitude > axis.deadzone) {
            // Rescale so the axis still reaches 1 at the stick's edge.
            const scale = (magnitude - axis.deadzone) / (1 - axis.deadzone) / magnitude;
            x += gx * scale;
            y += gy * scale;
          }
        }
      }
      out[0] = clamp(x);
      out[1] = clamp(y);
      return out;
    },

    bind(next): void {
      bound = next;
    },
  };
}

/**
 * Spell an action reference for an error message.
 *
 * @param action The name or handle the caller passed.
 *
 * @returns A quoted name, or the handle as a number.
 */
function describe(action: ActionRef): string {
  return typeof action === 'number' ? `handle ${String(action)}` : `"${action}"`;
}

/**
 * Compile one action specification.
 *
 * @param name The action name, for error messages.
 * @param spec The declaration.
 *
 * @returns The compiled action.
 */
function compile(name: string, spec: ActionSpec): CompiledAction {
  const action: CompiledAction = { keys: [], padButtons: [], axis: null };
  if (!('axis2' in spec)) {
    for (const binding of spec) {
      const pad = gamepadButtonIndex(binding);
      if (pad >= 0) {
        action.padButtons.push(pad);
        continue;
      }
      action.keys.push(resolve(name, binding));
      // `'Shift'` and friends name a left/right pair; bind both.
      const second = keyIndex2(binding);
      if (second >= 0) action.keys.push(second);
    }
    return action;
  }
  const axisSpec = spec;
  action.axis = {
    keys: [
      resolve(name, axisSpec.axis2[0]),
      resolve(name, axisSpec.axis2[1]),
      resolve(name, axisSpec.axis2[2]),
      resolve(name, axisSpec.axis2[3]),
    ],
    gamepadAxes: axisSpec.gamepadAxes ? [axisSpec.gamepadAxes[0], axisSpec.gamepadAxes[1]] : null,
    deadzone: axisSpec.deadzone ?? DEFAULT_DEADZONE,
    invertY: axisSpec.invertGamepadY ?? true,
  };
  // An axis2 action is also readable as a button: it is down while any of its
  // four directions is.
  action.keys.push(...action.axis.keys);
  return action;
}

/**
 * Resolve one binding spelling to a key index, or explain the typo.
 *
 * @param action The action name, for the error message.
 * @param binding The binding spelling.
 *
 * @returns The frozen key index.
 */
function resolve(action: string, binding: string): number {
  const index = keyIndex(binding);
  if (index < 0) {
    throw new Error(`action "${action}": unknown binding "${binding}"`);
  }
  return index;
}

/**
 * The first connected gamepad, if any.
 *
 * @param pads The preallocated gamepad slots.
 *
 * @returns The pad, or null.
 */
function firstConnected(pads: readonly GamepadState[]): GamepadState | null {
  for (const pad of pads) {
    if (pad.connected) return pad;
  }
  return null;
}

/**
 * Clamp to -1..1.
 *
 * @param value The raw axis value.
 *
 * @returns The clamped value.
 */
function clamp(value: number): number {
  if (value > 1) return 1;
  if (value < -1) return -1;
  return value;
}
