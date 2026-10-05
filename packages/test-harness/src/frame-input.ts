/**
 * Frame-input builders and the key/button helpers that drive them.
 *
 * Everything here produces **host-side** shapes: `frame` is a `bigint`, key
 * bitsets and axes are typed arrays, absent options are `undefined`. That is
 * exactly what `createSandbox(...).tick` expects in either mode, so the same
 * tape drives a direct guest and a wasm component.
 */
import { KEY_WORDS, keyIndex, keyIndex2, writeKeyBit } from '@gameable/sdk/keycodes';
import type {
  Contact,
  GameEvent,
  GamepadState,
  HostFrameInput,
  HostGameConfig,
  InputMods,
  InputState,
  MouseState,
  PlayerInput,
} from '@gameable/sdk';

/** A mutable, host-shaped input state. */
export interface MutableInputState extends InputState {
  keys: { down: Uint32Array; pressed: Uint32Array; released: Uint32Array };
  mods: InputMods;
  mouse: MouseState;
  gamepads: GamepadState[];
  focused: boolean;
}

/** Fields `createFrameInput` accepts. */
export interface FrameInputOverrides {
  /** Fixed-step counter. Accepts a number for convenience. */
  frame?: number | bigint;
  /** Fixed timestep in seconds. Default `1 / 60`. */
  dt?: number;
  /** Simulated seconds since init. Defaults to `frame * dt`. */
  elapsed?: number;
  /** Input state to reuse; a fresh neutral one is built when absent. */
  input?: MutableInputState;
  /** Packed body rows, stride 15. */
  bodies?: Float32Array;
  /** Reported contacts. */
  contacts?: readonly Contact[];
  /** Host-side events. */
  events?: readonly GameEvent[];
  /** Every player's input in a room, ascending by id. Empty by default: one player. */
  players?: readonly PlayerInput[];
}

/**
 * Build a neutral input state: nothing held, nothing moving, canvas focused.
 *
 * @returns A fresh mutable input state.
 *
 * @example
 * ```ts
 * import { createInputState, press } from 'gameable/test';
 *
 * const state = createInputState();
 * press(state, 'W');
 * ```
 */
export function createInputState(): MutableInputState {
  return {
    keys: {
      down: new Uint32Array(KEY_WORDS),
      pressed: new Uint32Array(KEY_WORDS),
      released: new Uint32Array(KEY_WORDS),
    },
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
      locked: true,
    },
    gamepads: [],
    focused: true,
  };
}

/**
 * Build one `frame-input`, in host-side shapes.
 *
 * @param overrides Anything to change from the neutral frame.
 * @returns A fresh frame input.
 *
 * @example
 * ```ts
 * import { createFrameInput } from 'gameable/test';
 *
 * const input = createFrameInput({ frame: 0 });
 * ```
 */
export function createFrameInput(overrides: FrameInputOverrides = {}): HostFrameInput {
  const dt = overrides.dt ?? 1 / 60;
  const frame =
    typeof overrides.frame === 'bigint' ? overrides.frame : BigInt(overrides.frame ?? 0);
  return {
    frame,
    dt,
    elapsed: overrides.elapsed ?? Number(frame) * dt,
    input: overrides.input ?? createInputState(),
    bodies: overrides.bodies ?? new Float32Array(0),
    contacts: overrides.contacts ?? [],
    events: overrides.events ?? [],
    players: overrides.players ?? [],
  };
}

/**
 * Build a `game-config`, in host-side shapes.
 *
 * @param overrides Anything to change from the defaults.
 * @returns A fresh config.
 *
 * @example
 * ```ts
 * import { createGameConfig } from 'gameable/test';
 *
 * sandbox.init(createGameConfig({ seed: 7n }));
 * ```
 */
export function createGameConfig(overrides: Partial<HostGameConfig> = {}): HostGameConfig {
  return {
    seed: overrides.seed ?? 0x5eed1234n,
    fixedHz: overrides.fixedHz ?? 60,
    viewportWidth: overrides.viewportWidth ?? 1920,
    viewportHeight: overrides.viewportHeight ?? 1080,
    devMode: overrides.devMode ?? true,
    options: overrides.options,
  };
}

/**
 * Hold a key down and record the press edge.
 *
 * @param state The input state to mutate.
 * @param key A key name: `'KeyW'`, `'W'`, `'Shift'`.
 * @returns Nothing.
 *
 * @example
 * ```ts
 * import { createInputState, press } from 'gameable/test';
 *
 * const state = createInputState();
 * press(state, 'Space');
 * ```
 */
export function press(state: MutableInputState, key: string): void {
  const a = keyIndex(key);
  if (a < 0) throw new Error(`unknown key "${key}"`);
  writeKeyBit(state.keys.down, a, true);
  writeKeyBit(state.keys.pressed, a, true);
  writeKeyBit(state.keys.released, a, false);
  const b = keyIndex2(key);
  if (b >= 0) {
    writeKeyBit(state.keys.down, b, true);
    writeKeyBit(state.keys.pressed, b, true);
  }
}

/**
 * Release a key and record the release edge.
 *
 * @param state The input state to mutate.
 * @param key A key name.
 * @returns Nothing.
 *
 * @example
 * ```ts
 * import { release } from 'gameable/test';
 *
 * release(state, 'Space');
 * ```
 */
export function release(state: MutableInputState, key: string): void {
  const a = keyIndex(key);
  if (a < 0) throw new Error(`unknown key "${key}"`);
  writeKeyBit(state.keys.down, a, false);
  writeKeyBit(state.keys.pressed, a, false);
  writeKeyBit(state.keys.released, a, true);
  const b = keyIndex2(key);
  if (b >= 0) {
    writeKeyBit(state.keys.down, b, false);
    writeKeyBit(state.keys.released, b, true);
  }
}

/**
 * Clear the per-frame edges, keeping held keys held.
 *
 * Call this between frames, exactly as `gameable/input` does.
 *
 * @param state The input state to mutate.
 * @returns Nothing.
 *
 * @example
 * ```ts
 * import { endFrame } from 'gameable/test';
 *
 * endFrame(state);
 * ```
 */
export function endFrame(state: MutableInputState): void {
  state.keys.pressed.fill(0);
  state.keys.released.fill(0);
  state.mouse.pressed = 0;
  state.mouse.released = 0;
  state.mouse.dx = 0;
  state.mouse.dy = 0;
  state.mouse.wheel = 0;
}

/**
 * Press a mouse button.
 *
 * @param state The input state to mutate.
 * @param button A bit mask; 1 left, 2 right, 4 middle.
 * @returns Nothing.
 *
 * @example
 * ```ts
 * import { pressMouse } from 'gameable/test';
 *
 * pressMouse(state, 1);
 * ```
 */
export function pressMouse(state: MutableInputState, button: number): void {
  state.mouse.buttons |= button;
  state.mouse.pressed |= button;
  state.mouse.released &= ~button;
}

/**
 * Release a mouse button.
 *
 * @param state The input state to mutate.
 * @param button A bit mask.
 * @returns Nothing.
 *
 * @example
 * ```ts
 * import { releaseMouse } from 'gameable/test';
 *
 * releaseMouse(state, 1);
 * ```
 */
export function releaseMouse(state: MutableInputState, button: number): void {
  state.mouse.buttons &= ~button;
  state.mouse.pressed &= ~button;
  state.mouse.released |= button;
}

/**
 * Build a packed `bodies` row set, stride 15.
 *
 * @param rows One entry per live body.
 * @returns A `Float32Array` sorted ascending by body id.
 *
 * @example
 * ```ts
 * import { packBodies } from 'gameable/test';
 *
 * const bodies = packBodies([{ body: 1, position: [0, 1, 0] }]);
 * ```
 */
export function packBodies(
  rows: readonly {
    body: number;
    position?: readonly number[];
    rotation?: readonly number[];
    linear?: readonly number[];
    angular?: readonly number[];
    /** Packed contact: 0 unknown, 1 ground, 2 steep, 3 unsupported, 4 air. */
    groundState?: number;
  }[],
): Float32Array {
  const sorted = [...rows].sort((a, b) => a.body - b.body);
  const out = new Float32Array(sorted.length * 15);
  for (let i = 0; i < sorted.length; i += 1) {
    const row = sorted[i];
    const o = i * 15;
    out[o] = row.body;
    out[o + 1] = row.position?.[0] ?? 0;
    out[o + 2] = row.position?.[1] ?? 0;
    out[o + 3] = row.position?.[2] ?? 0;
    out[o + 4] = row.rotation?.[0] ?? 0;
    out[o + 5] = row.rotation?.[1] ?? 0;
    out[o + 6] = row.rotation?.[2] ?? 0;
    out[o + 7] = row.rotation?.[3] ?? 1;
    out[o + 8] = row.linear?.[0] ?? 0;
    out[o + 9] = row.linear?.[1] ?? 0;
    out[o + 10] = row.linear?.[2] ?? 0;
    out[o + 11] = row.angular?.[0] ?? 0;
    out[o + 12] = row.angular?.[1] ?? 0;
    out[o + 13] = row.angular?.[2] ?? 0;
    out[o + 14] = row.groundState ?? 0;
  }
  return out;
}
