/**
 * The `gameable:engine@0.2.0` net and data vocabulary, in the shapes jco lifts and
 * lowers: one player's input in a room, the five room events and the six
 * commands a game sends to players and to the room's store.
 *
 * Kept apart from `types.ts` so the multiplayer half of the contract reads in
 * one place; `types.ts` folds these into `GameEvent` and `Command` and
 * re-exports them.
 */
import type { CameraState, InputState } from './types';

/** One player's input for a step, as `frame-input.players` carries it. */
export interface PlayerInput {
  /** The player id. 0 is the single-player player, which travels as `frame-input.input`. */
  player: number;
  /** The client's input sequence number this step consumed; 0 when unknown. */
  seq: number;
  /** That player's keys, mouse and gamepads. */
  input: InputState;
}

/** A player entered the room. */
export interface PlayerJoinedEvent {
  player: number;
  name: string;
  /**
   * The player's saved document as JSON, when the room has a store. Absent
   * otherwise (`null` in a wasm guest, as every incoming `option` is).
   */
  data?: string;
}

/** A player left the room. */
export interface PlayerLeftEvent {
  player: number;
  /** Why: `"left"`, `"timeout"`, `"kicked"`, ... */
  reason: string;
}

/**
 * A game message a player sent, delivered to the authority on its next tick.
 *
 * Named `NetMessageEvent` rather than the WIT's `message-event` so it never
 * shadows the DOM's `MessageEvent` in a page that imports both.
 */
export interface NetMessageEvent {
  /** The sender. */
  player: number;
  name: string;
  /** JSON. */
  payload: string;
}

/** The outcome of an `exchange` command, matched by its `id`. */
export interface ExchangeResultEvent {
  id: number;
  ok: boolean;
  /** Empty when `ok`. */
  reason: string;
  /** Player `a`'s document after the trade, as the store wrote it (JSON); empty unless `ok`. */
  aData: string;
  /** Player `b`'s document after the trade (JSON); empty unless `ok`. */
  bData: string;
}

/** The room's saved game-wide document as JSON. */
export interface GameDataEvent {
  data: string;
}

/** Send a game message to one player, every player, or up to the authority. */
export interface SendCmd {
  /** One player; absent sends to every player (authority) or to the authority (client). */
  to?: number;
  name: string;
  /** JSON, at most 2,048 bytes. */
  payload: string;
  reliable: boolean;
}

/** The camera one player renders from. */
export interface SetPlayerCameraCmd {
  player: number;
  camera: CameraState;
}

/** One player's HUD model as JSON. */
export interface SetPlayerHudCmd {
  player: number;
  hud: string;
}

/** Persist one player's document (JSON). Authority only. */
export interface SavePlayerDataCmd {
  player: number;
  data: string;
}

/**
 * Which entity a player controls. The authority sends it when it spawns
 * `definition.player` for a join and on every `PlayerHandle.possess`; the
 * host keeps the mapping (relevancy, "which entity is mine" on the client).
 */
export interface SetPlayerEntityCmd {
  player: number;
  entity: number;
}

/** Persist the room's game-wide document (JSON). Authority only. */
export interface SaveGameDataCmd {
  data: string;
}

/** Trade between two players' documents; the result is an `exchange-result` event. */
export interface ExchangeCmd {
  /** Guest-minted; echoed in the result. */
  id: number;
  a: number;
  b: number;
  /** JSON: what `a` gives `b`. */
  give: string;
  /** JSON: what `a` takes from `b`. */
  take: string;
}

/** The net and data members of the `event` variant. */
export type NetEvent =
  | { tag: 'player-joined'; val: PlayerJoinedEvent }
  | { tag: 'player-left'; val: PlayerLeftEvent }
  | { tag: 'message'; val: NetMessageEvent }
  | { tag: 'exchange-result'; val: ExchangeResultEvent }
  | { tag: 'game-data'; val: GameDataEvent };

/** The net and data members of the `command` variant. */
export type NetCommand =
  | { tag: 'send'; val: SendCmd }
  | { tag: 'set-player-camera'; val: SetPlayerCameraCmd }
  | { tag: 'set-player-hud'; val: SetPlayerHudCmd }
  | { tag: 'save-player-data'; val: SavePlayerDataCmd }
  | { tag: 'save-game-data'; val: SaveGameDataCmd }
  | { tag: 'set-player-entity'; val: SetPlayerEntityCmd }
  | { tag: 'exchange'; val: ExchangeCmd };
