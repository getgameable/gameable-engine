/**
 * The single mutable runtime the facades read.
 *
 * `input`, `physics`, `camera`, `hud`, `audio`, `character` and `rng` are
 * module singletons, because that is the API a game author wants
 * (`input.isDown('W')`, not `ctx.services.input.isDown('W')`). They stay
 * correct when several guests exist in one realm — a parity test runs a direct
 * guest and a wasm guest side by side — because the runtime installs itself as
 * *the* active state for the duration of each synchronous `init` / `tick` /
 * `shutdown` call and removes itself afterwards.
 */
import type { BodyIndex, TransformPacker } from './packing';
import type { InputLanes } from './inputLanes';
import type { NetCommandBuffer, NetConfig, PlayerTable } from './net';
import type { Rng } from './rng';
import type {
  AssetDesc,
  CameraState,
  Contact,
  GameConfig,
  GameEvent,
  HostApi,
  InputMods,
  MouseState,
} from './types';

/** A gamepad snapshot the SDK owns and reuses every frame. */
export interface MutableGamepad {
  index: number;
  connected: boolean;
  buttons: number;
  pressed: number;
  released: number;
  /** Standard mapping: lx, ly, rx, ry, left trigger, right trigger. */
  axes: Float32Array;
}

/** HUD change detection state. */
export interface HudState {
  /** Shallow copy of the last model the game set, or null before the first. */
  last: Record<string, unknown> | null;
  /** JSON to emit this frame, or undefined when the model did not change. */
  pending: string | undefined;
}

/** First-person / third-person look accumulator owned by the built-in camera. */
export interface LookState {
  yaw: number;
  pitch: number;
  sensitivity: number;
}

/** Everything one guest instance owns. */
export interface RuntimeState {
  host: HostApi;
  config: GameConfig;
  /** The bitecs world. Typed loosely so the SDK does not leak bitecs generics. */
  world: object;

  frame: number;
  dt: number;
  elapsed: number;

  rng: Rng;
  packer: TransformPacker;
  bodyIndex: BodyIndex;
  /**
   * Where the facades queue commands: the network buffer behind
   * `frame-output.commands`, or `localCommands` inside `ctx.net.local`.
   */
  commands: NetCommandBuffer;
  /** `frame-output.local-commands`: applied by the authority, never forwarded. */
  localCommands: NetCommandBuffer;
  camera: CameraState;
  look: LookState;
  hud: HudState;

  keysDown: Uint32Array;
  keysPressed: Uint32Array;
  keysReleased: Uint32Array;
  mods: InputMods;
  mouse: MouseState;
  gamepads: MutableGamepad[];
  gamepadCount: number;
  focused: boolean;
  /**
   * The lanes the singleton `input` reads: this runtime's own (above) in a
   * single-player game and on the authority, the local player's slot on a client.
   */
  inputLanes: InputLanes;

  contacts: readonly Contact[];
  events: readonly GameEvent[];
  /** `frame-input.players`, decoded into slots made in `init`. */
  players: PlayerTable;
  /** The `net` block of `game-config.options`, read in `init`. */
  net: NetConfig;

  /** Next guest-minted body id. Counters start at 1; 0 means "none". */
  nextBody: number;
  /** Next guest-minted sound handle. */
  nextSound: number;
  /** Manifest string id to asset handle, resolved once and cached. */
  assetIds: Map<string, number>;
  /**
   * Asset handle to its description, cached because the manifest is immutable
   * for the life of a run. Per runtime, never module scope: a parity run has a
   * direct guest and a wasm guest, with different hosts, in one realm.
   */
  assetDescs: Map<number, AssetDesc | null>;
  /** True once `init` has completed. Asset resolution warns after this. */
  initialised: boolean;

  /** The player entity, when the declarative `player` block created one. */
  player: number;

  /**
   * True when the command buffer holds commands built outside `tick` — the
   * spawns `init` queued. The next `tick` keeps them instead of resetting.
   */
  carryCommands: boolean;

  /** Set after repeated user-code failures; the host must rebuild the sandbox. */
  dead: boolean;
  /** Consecutive failed ticks. */
  failures: number;
}

let active: RuntimeState | null = null;

/**
 * The runtime that owns this realm's component stores: the one whose `init`
 * ran last. The stores (`Transform`, `Health`, ...) are module singletons and
 * `init` reconfigures them, so once a second direct guest has started in this
 * realm, the first one's entities are gone and every later call it made would
 * write the newer guest's entities.
 */
let realmOwner: RuntimeState | null = null;

/**
 * Take the realm's component stores for `rt`. `init` only.
 *
 * @param rt The runtime starting.
 */
export function claimRealm(rt: RuntimeState): void {
  realmOwner = rt;
}

/**
 * Refuse to run a guest whose component stores another runtime has taken.
 * `tick`, `snapshot` and `restore` only.
 *
 * @param rt The runtime about to run.
 * @throws {Error} When another direct guest started in this realm after `rt`
 *   did: the two would overwrite each other's entities.
 */
export function checkRealm(rt: RuntimeState): void {
  if (realmOwner === rt) return;
  throw new Error(
    'two direct guests in one realm: another gameable game started in this JS realm after this ' +
      "one, and the SDK's component arrays are shared, so they would overwrite each other. Run " +
      'one of them as a wasm guest (or in a Worker), or shut the first one down for good.',
  );
}

/**
 * Give the realm back. `shutdown` only.
 *
 * @param rt The runtime shutting down.
 */
export function releaseRealm(rt: RuntimeState): void {
  if (realmOwner === rt) realmOwner = null;
}

/**
 * Install the runtime the facades resolve against.
 *
 * @param next The runtime, or `null` when leaving a guest call.
 * @returns The previously active runtime, so calls can nest.
 */
export function setActiveRuntime(next: RuntimeState | null): RuntimeState | null {
  const previous = active;
  active = next;
  return previous;
}

/**
 * The runtime currently executing, or `null` outside a guest call.
 *
 * @returns The active runtime.
 */
export function getActiveRuntime(): RuntimeState | null {
  return active;
}

/**
 * The runtime currently executing.
 *
 * @returns The active runtime.
 * @throws When called outside `init`, `tick` or `shutdown`.
 */
export function requireRuntime(): RuntimeState {
  if (!active) {
    throw new Error(
      'No gameable guest is running. The SDK facades (input, physics, camera, ' +
        'hud, audio, character, rng) only work inside init(), a system, update() ' +
        'or shutdown().',
    );
  }
  return active;
}
