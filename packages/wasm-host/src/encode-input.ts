/**
 * Building `frame-input` from engine state, without allocating.
 *
 * One encoder per sandbox owns every object it hands over, so the per-frame
 * cost is the writes plus the one `BigInt` the `u64` frame counter forces.
 * The guest copies what it needs out of these objects during `tick`, so
 * reusing them across frames is safe.
 *
 * **Nothing is copied that the guest is going to copy anyway.** The key
 * bitsets are aliased straight out of the input module's state, and the body
 * rows are handed over as a memoised `subarray` of the caller's own buffer.
 * Two copies of 3.5 KB per frame bought nothing: the guest copies on its way
 * in (`packages/sdk/src/runtime.ts`), and the wasm lowering copies again.
 *
 * The players lane (`frame-input.players`, a room's every player) is built the
 * same way: one pooled record per player, keys aliased, mods and mouse copied
 * (so `quantizeInput` rounds the encoder's floats, never the caller's), and the
 * list itself a memoised prefix of the pool, one per player count.
 */
import type {
  Contact,
  GameEvent,
  GamepadState,
  HostFrameInput,
  InputMods,
  InputState,
  MouseState,
  PlayerInput,
} from '@gameable/sdk';
import { KEY_WORDS } from '@gameable/sdk';

/** The shape the engine's input module hands over each frame. */
export interface InputSnapshot {
  /**
   * Keys held, `KEY_WORDS` words. Aliased into the frame input, not copied:
   * the array must stay alive and must not be recycled mid-tick.
   */
  down: Uint32Array;
  /** Keys that went down this step, aliased like {@link InputSnapshot.down}. */
  pressed: Uint32Array;
  /** Keys that came up this step, aliased like {@link InputSnapshot.down}. */
  released: Uint32Array;
  mods: InputMods;
  mouse: MouseState;
  gamepads?: readonly GamepadState[];
  focused: boolean;
}

/** Everything an encoder needs for one fixed step. */
export interface EncodeArgs {
  /** Fixed-step counter. */
  frame: number;
  /** Fixed timestep in seconds. */
  dt: number;
  /** Simulated seconds since init. */
  elapsed: number;
  /** Host input state. */
  inputState: InputSnapshot;
  /**
   * Packed body rows, stride 15, sorted ascending by body id.
   *
   * Handed to the guest as a view of this very buffer, so the caller may grow
   * it whenever it likes — the encoder notices the new identity and drops the
   * views it memoised over the old one.
   */
  bodies: Float32Array;
  /** Live body count; `bodies` may be longer. */
  bodyCount: number;
  /** Reported contacts. */
  contacts?: readonly Contact[];
  /** Host-side events since the previous tick. */
  events?: readonly GameEvent[];
  /** Every player's input in a room, ascending by id. Absent or empty for one player. */
  players?: readonly PlayerInput[];
}

/** A reusable `frame-input` builder. */
export interface InputEncoder {
  /** Build the next frame input. The returned object is reused. */
  encode(args: EncodeArgs): HostFrameInput;
}

const EMPTY_CONTACTS: readonly Contact[] = [];
const EMPTY_EVENTS: readonly GameEvent[] = [];
const EMPTY_PLAYERS: readonly PlayerInput[] = [];
const EMPTY_PADS: readonly GamepadState[] = [];
/** Floats per packed body row: id, position, rotation, linear, angular, flags. */
const BODY_STRIDE = 15;

/** @returns A neutral `input-state` the encoder owns, keys aliased later. */
function makeInputState(): InputState {
  const empty = new Uint32Array(KEY_WORDS);
  return {
    keys: { down: empty, pressed: empty, released: empty },
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
    gamepads: EMPTY_PADS,
    focused: true,
  };
}

/**
 * Point an owned `input-state` at a source: keys and gamepads aliased, mods and mouse copied.
 *
 * @param to The encoder's record.
 * @param src The caller's input.
 */
function fillInputState(to: InputState, src: InputSnapshot | InputState): void {
  const keys = to.keys;
  const from = 'keys' in src ? src.keys : src;
  keys.down = from.down;
  keys.pressed = from.pressed;
  keys.released = from.released;
  const mods = to.mods;
  mods.shift = src.mods.shift;
  mods.ctrl = src.mods.ctrl;
  mods.alt = src.mods.alt;
  mods.meta = src.mods.meta;
  mods.capsLock = src.mods.capsLock;
  mods.numLock = src.mods.numLock;
  const mouse = to.mouse;
  mouse.x = src.mouse.x;
  mouse.y = src.mouse.y;
  mouse.dx = src.mouse.dx;
  mouse.dy = src.mouse.dy;
  mouse.wheel = src.mouse.wheel;
  mouse.buttons = src.mouse.buttons;
  mouse.pressed = src.mouse.pressed;
  mouse.released = src.mouse.released;
  mouse.locked = src.mouse.locked;
  to.gamepads = src.gamepads ?? EMPTY_PADS;
  to.focused = src.focused;
}

/**
 * Create a reusable `frame-input` builder.
 *
 * @param maxBodies Initial hint for the memoised view table — **not** a
 *   ceiling. A frame with more rows than this still reaches the guest whole;
 *   the hint only decides how many `subarray` views are preallocated, and the
 *   table grows with the game.
 * @returns An encoder that reuses one frame-input record.
 *
 * @example
 * ```ts
 * import { createInputEncoder } from 'gameable/host';
 *
 * const encoder = createInputEncoder(2048);
 * const input = encoder.encode({ frame, dt, elapsed, inputState, bodies, bodyCount });
 * ```
 */
export function createInputEncoder(maxBodies = 4096): InputEncoder {
  const input = makeInputState();
  /** One record per player ever seen in a step; only appended to. */
  const playerPool: PlayerInput[] = [];
  /** `playerPool.slice(0, n)`, memoised by `n`, so a steady room allocates no list. */
  const playerLists: (readonly PlayerInput[] | undefined)[] = [EMPTY_PLAYERS];

  /**
   * The buffer the memoised views below are windows onto.
   *
   * A view over a buffer the caller has thrown away would be a frame of stale
   * bodies, so the table is emptied the moment the identity changes — which is
   * the only way a caller is allowed to grow it.
   */
  let viewsOf: Float32Array | null = null;
  /** Memoised prefixes of {@link viewsOf}, indexed by row count. */
  let bodyViews: (Float32Array | undefined)[] = new Array<Float32Array | undefined>(
    Math.max(1, maxBodies) + 1,
  ).fill(undefined);

  const frameInput: HostFrameInput = {
    frame: 0n,
    dt: 1 / 60,
    elapsed: 0,
    input,
    bodies: new Float32Array(0),
    contacts: EMPTY_CONTACTS,
    events: EMPTY_EVENTS,
    players: EMPTY_PLAYERS,
  };

  /**
   * @param src The caller's players.
   * @returns The pooled players lane for this step.
   */
  function encodePlayers(src: readonly PlayerInput[]): readonly PlayerInput[] {
    const n = src.length;
    while (playerPool.length < n) playerPool.push({ player: 0, seq: 0, input: makeInputState() });
    for (let i = 0; i < n; i += 1) {
      const to = playerPool[i];
      to.player = src[i].player;
      to.seq = src[i].seq;
      fillInputState(to.input, src[i].input);
    }
    let list = playerLists[n];
    if (list === undefined) {
      list = playerPool.slice(0, n);
      playerLists[n] = list;
    }
    return list;
  }

  return {
    encode(args: EncodeArgs): HostFrameInput {
      // `frame` is a `u64`: the host side must hand jco a bigint. This is the
      // one unavoidable allocation per frame on the host side.
      frameInput.frame = BigInt(args.frame);
      frameInput.dt = args.dt;
      frameInput.elapsed = args.elapsed;

      fillInputState(input, args.inputState);
      frameInput.players = encodePlayers(args.players ?? EMPTY_PLAYERS);

      const buffer = args.bodies;
      if (buffer !== viewsOf) {
        viewsOf = buffer;
        bodyViews = new Array<Float32Array | undefined>(bodyViews.length).fill(undefined);
      }
      const capacity = (buffer.length / BODY_STRIDE) | 0;
      const count = args.bodyCount < capacity ? args.bodyCount : capacity;
      let view = bodyViews[count];
      if (view === undefined) {
        view = buffer.subarray(0, count * BODY_STRIDE);
        bodyViews[count] = view;
      }
      frameInput.bodies = view;

      frameInput.contacts = args.contacts ?? EMPTY_CONTACTS;
      frameInput.events = args.events ?? EMPTY_EVENTS;
      return frameInput;
    },
  };
}
