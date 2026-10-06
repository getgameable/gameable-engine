/**
 * The server adapter's options, sinks, per-player output and input source.
 * The world record's own shapes are in `recordTypes.ts`, re-exported here.
 */
import type { CameraState, ExchangeCmd, InputState, SendCmd } from '@gameable/sdk';

export type {
  AnimRecord,
  BodyShapeRecord,
  CharacterRecord,
  EntityRecord,
  EntitySnapshot,
  VisualSnapshot,
  WorldSnapshot,
} from './recordTypes';

/**
 * What one player is shown this tick beyond the shared world.
 *
 * `adapter.perPlayer[id]`. The guest's frame camera and HUD are player 0's;
 * `set-player-camera` and `set-player-hud` land on the player they name.
 *
 * @example
 * ```ts
 * const two = adapter.perPlayer[2];
 * if (two?.hud !== undefined) console.log(two.hud);
 * ```
 */
export interface PerPlayerOutput {
  /** The player id. */
  readonly player: number;
  /** The camera the guest last asked for, copied; `undefined` before the first. */
  camera: CameraState | undefined;
  /**
   * Where `camera` came from: `player` once the guest sent this player a
   * `set-player-camera`, `frame` when it is the frame's own camera (player 0
   * only, and also the guest's default when it never set one), `none` before
   * either.
   */
  cameraSource: 'none' | 'frame' | 'player';
  /** The HUD JSON the guest last sent, or `undefined` before the first. */
  hud: string | undefined;
  /**
   * Messages addressed to this player this tick, as pooled copies; cleared by
   * `beginTick()`. Sends with no `to` are on `adapter.broadcasts` instead.
   */
  readonly sends: SendCmd[];
}

/**
 * Where an authority's data commands go: the room's store (Task 5.2).
 *
 * Every argument is read during the call: `exchange`'s command is pooled by
 * the guest and rewritten on its next tick.
 *
 * @example
 * ```ts
 * const sink: DataSink = {
 *   savePlayer: (player, data) => store.save(player, data),
 *   saveGame: (data) => store.saveGame(data),
 *   exchange: (cmd) => store.exchange({ ...cmd }),
 * };
 * const adapter = createServerAdapter(physics, { dataSink: sink });
 * ```
 */
export interface DataSink {
  /** Persist one player's document (JSON). */
  savePlayer(player: number, data: string): void;
  /** Persist the room's game-wide document (JSON). */
  saveGame(data: string): void;
  /** Trade between two players' documents; answer with an `exchange-result` event. */
  exchange(cmd: ExchangeCmd): void;
}

/**
 * Where the server adapter's one-time warnings go.
 *
 * @example
 * ```ts
 * const warn: WarnSink = (message) => log.warn(message);
 * ```
 */
export type WarnSink = (message: string) => void;

/**
 * Options accepted by `createServerAdapter`.
 *
 * @example
 * ```ts
 * const adapter = createServerAdapter(physics, { maxBodies: 16384, warn: log.warn });
 * ```
 */
export interface ServerAdapterOptions {
  /** Body ids the body-to-entity table holds before it first grows. Defaults to 4096. */
  maxBodies?: number;
  /** Where the one-time warnings go. Defaults to `console.warn`. */
  warn?: WarnSink;
  /**
   * Where `save-player-data`, `save-game-data` and `exchange` go. Defaults to
   * a sink that drops them and warns once each: a room with no store.
   */
  dataSink?: DataSink;
}

/**
 * Where the server loop gets each player's input for the next tick.
 *
 * The loop reads it once per fixed step and never keeps it. Edges
 * (`keys.pressed`, `keys.released`, the mouse edges and deltas) are the
 * source's to clear between steps: the loop hands the guest exactly what it is
 * given. Player 0's snapshot is `frame-input.input`; every id in `players()`
 * is also handed over in `frame-input.players`.
 *
 * @example
 * ```ts
 * import { createInputState, press } from 'gameable/test';
 * import type { InputSource } from 'gameable/host/server';
 *
 * const input = createInputState();
 * press(input, 'W');
 * const inputs: InputSource = { players: () => [0], snapshotFor: () => input };
 * ```
 */
export interface InputSource {
  /**
   * @returns The ids of the players in the room this tick, **in ascending
   *   order** (the WIT's `frame-input.players` is ascending by id, and the
   *   loop does not sort). Must not allocate per call. A server loop in dev
   *   mode warns once when the order is wrong.
   */
  players(): readonly number[];
  /**
   * @param player A player id from {@link InputSource.players}.
   * @returns That player's input for the next tick; read during the call, not retained.
   */
  snapshotFor(player: number): PlayerInput;
  /**
   * @param player A player id from {@link InputSource.players}.
   * @returns The client sequence number of that input, for `player-input.seq`.
   *   Optional: without it every `seq` is 0.
   */
  seqFor?(player: number): number;
}

/**
 * One player's input in the WIT `input-state` shape, with the key bitsets as
 * `KEY_WORDS`-long `Uint32Array`s (the shape the frame encoder aliases).
 *
 * `createInputState()` from `gameable/test` makes one.
 *
 * @example
 * ```ts
 * import { KEY_WORDS } from 'gameable';
 * import type { PlayerInput } from 'gameable/host/server';
 *
 * const keys = () => new Uint32Array(KEY_WORDS);
 * const idle: PlayerInput = {
 *   keys: { down: keys(), pressed: keys(), released: keys() },
 *   mods: { shift: false, ctrl: false, alt: false, meta: false, capsLock: false, numLock: false },
 *   mouse: { x: 0, y: 0, dx: 0, dy: 0, wheel: 0, buttons: 0, pressed: 0, released: 0, locked: true },
 *   gamepads: [],
 *   focused: true,
 * };
 * ```
 */
export interface PlayerInput extends InputState {
  /** Held keys and this step's edges, `KEY_WORDS` words each. */
  keys: { down: Uint32Array; pressed: Uint32Array; released: Uint32Array };
}
