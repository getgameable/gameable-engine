/**
 * The shapes the wire protocol moves: the JSON text frames each side sends,
 * the input a client encodes each step, and the row source and sink the rows
 * codec reads from and writes into.
 */
import type { Command } from '@gameable/sdk';

/** One player as the room lists them. */
export interface PlayerSummary {
  /** The player id, stable for the seat's life. */
  id: number;
  /** The display name the player joined with. */
  name: string;
  /** False while the seat is held for a reconnect. */
  connected: boolean;
}

/** Why the server refused or closed a connection. */
export type ServerErrorCode = 'room' | 'full' | 'seat' | 'origin' | 'budget' | 'version' | 'ended';

/** A JSON text frame a client sends, discriminated by `t`. */
export type ClientText =
  | {
      t: 'hello';
      v: number;
      room: string;
      name: string;
      seat?: { id: number; secret: string };
      token?: string;
    }
  | { t: 'msg'; name: string; payload: unknown }
  | { t: 'ping'; at: number };

/** A JSON text frame the server sends, discriminated by `t`. */
export type ServerText =
  | {
      t: 'welcome';
      player: number;
      /** The entity this player controls, or 0 for none: "which entity is mine". */
      entity: number;
      /** The room's code, as the server knows it (the code to share); absent from a server that does not say. */
      room?: string;
      secret: string;
      frame: number;
      snapshot: unknown;
      players: PlayerSummary[];
    }
  /** `entity`: the entity this player controls now, or 0 (a possess or a despawn changes it). */
  | { t: 'cmd'; frame: number; ack: number; entity: number; commands: Command[] }
  | { t: 'players'; players: PlayerSummary[] }
  | { t: 'msg'; from: number; name: string; payload: unknown }
  | { t: 'pong'; at: number; server: number }
  | { t: 'error'; code: ServerErrorCode; detail?: string };

/** Modifier keys, one bit each on the wire. */
export interface WireMods {
  shift: boolean;
  ctrl: boolean;
  alt: boolean;
  meta: boolean;
  capsLock: boolean;
  numLock: boolean;
}

/**
 * The mouse fields the wire carries. Deltas round to whole pixels and clamp to
 * `i16`, the wheel to `i8`, the button masks to their low 8 bits.
 */
export interface WireMouse {
  dx: number;
  dy: number;
  wheel: number;
  buttons: number;
  pressed: number;
  released: number;
}

/**
 * One step of input as `encodeInput` reads it. The host's input snapshot fits
 * this shape as it is; nothing has to be copied into it.
 */
export interface InputSnapshotLike {
  /** Keys held, `KEY_WORDS` words. */
  readonly down: Uint32Array;
  /** Keys that went down this step, `KEY_WORDS` words. */
  readonly pressed: Uint32Array;
  /** Keys that came up this step, `KEY_WORDS` words. */
  readonly released: Uint32Array;
  readonly mods: Readonly<WireMods>;
  readonly mouse: Readonly<WireMouse>;
  readonly focused: boolean;
}

/**
 * The record `decodeInput` writes into. The caller owns it and its arrays, so
 * one record can be reused for every frame from a player.
 */
export interface MutableInputSnapshot {
  readonly down: Uint32Array;
  readonly pressed: Uint32Array;
  readonly released: Uint32Array;
  readonly mods: WireMods;
  readonly mouse: WireMouse;
  focused: boolean;
}

/** What `decodeInput` read besides the snapshot; reused across calls. */
export interface InputHeader {
  seq: number;
}

/**
 * Rows to encode, addressed by index. Lanes are read only when the row's flags
 * name them, and are read in place: a world record's own arrays can be handed
 * back without a copy.
 */
export interface RowSource {
  /** How many rows to write. */
  readonly count: number;
  /** The entity id of row `index`. */
  entity(index: number): number;
  /** The `RowFlag` bits of row `index`. */
  flags(index: number): number;
  /** Position xyz of row `index`, metres. */
  position(index: number): ArrayLike<number>;
  /** Rotation quaternion xyzw of row `index`. */
  rotation(index: number): ArrayLike<number>;
  /** Scale xyz of row `index`. */
  scale(index: number): ArrayLike<number>;
  /**
   * The receiving player's own body, written as the frame's trailer after
   * the rows; null or absent for a spectator (no entity, or no body). The
   * trailer's `seq` is the frame's `ack`.
   */
  readonly player?: PlayerRowSource | null;
}

/**
 * One player's own body as the authority has it after a step, read in place
 * when a rows frame is encoded.
 */
export interface PlayerRowSource {
  /** The entity the player controls. */
  readonly entity: number;
  /** Body position xyz, metres. */
  readonly position: ArrayLike<number>;
  /** Body linear velocity xyz, metres per second. */
  readonly velocity: ArrayLike<number>;
  /** `PlayerRowFlag` bits: grounded, teleported. */
  readonly flags: number;
}

/**
 * A decoded player trailer. The codec owns one and rewrites it every
 * decode: read it, or copy it, before the next.
 */
export interface PlayerRow {
  /** The entity the player controls. */
  entity: number;
  /** The newest input `seq` the authority had applied for this player when it read the body. */
  seq: number;
  /** Body position xyz, metres, exact `f32`. */
  readonly position: Float32Array;
  /** Body linear velocity xyz, metres per second. */
  readonly velocity: Float32Array;
  /** `PlayerRowFlag` bits. */
  flags: number;
}

/**
 * Where decoded rows go. Before each `row` call the decoder writes the lanes
 * the flags name into the sink's own arrays; lanes the row does not carry are
 * left as they were.
 */
export interface RowSink {
  /** At least three lanes: position xyz, metres. */
  readonly position: Float32Array;
  /** At least four lanes: rotation xyzw. */
  readonly rotation: Float32Array;
  /** At least three lanes: scale xyz. */
  readonly scale: Float32Array;
  /** One decoded row; read the arrays now, the next row overwrites them. */
  row(entity: number, flags: number): void;
  /**
   * The frame's player trailer, after its last row; never called for a frame
   * without one. A sink that leaves it out ignores the trailer.
   */
  player?(row: PlayerRow): void;
}

/** What `decodeRows` read besides the rows; reused across calls. */
export interface RowsHeader {
  frame: number;
  ack: number;
  count: number;
  /** The player trailer, or null when the frame has none. */
  player: PlayerRow | null;
}

/**
 * Why a client text frame was refused: `size` (over the cap), `depth` (nested
 * too deep), `json` (not JSON), `type` (no known `t`), `shape` (the fields are wrong).
 */
export type ClientTextFailure = 'size' | 'depth' | 'json' | 'type' | 'shape';
