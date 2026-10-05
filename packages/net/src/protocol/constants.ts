/**
 * The wire protocol's fixed numbers: its version, the payload cap, the binary
 * frame kinds, the row lane flags and the byte sizes the codecs check against.
 */
import { KEY_WORDS } from '@gameable/sdk/keycodes';
import { AUTHORITY_SENDER, MAX_PAYLOAD_BYTES } from '@gameable/sdk/wire';

/** The protocol version a client sends in `hello`; a mismatch is refused. */
export const PROTOCOL_VERSION = 1;

/**
 * The `from` of a `msg` the authority sent (past every player id, still a
 * `u32`), and the largest `msg` payload in UTF-8 bytes of its JSON. Both are
 * the SDK's own (`gameable/sdk/wire`), so the guest's `ctx.net.send` check
 * and the wire's agree.
 */
export { AUTHORITY_SENDER, MAX_PAYLOAD_BYTES };

/**
 * The largest text frame a client may send, in UTF-8 bytes: a full payload
 * plus room for the envelope (`t`, the message name, a `hello`'s fields).
 */
export const MAX_CLIENT_TEXT_BYTES = MAX_PAYLOAD_BYTES + 512;

/**
 * The deepest nesting of arrays and objects a text frame may carry; a deeper
 * frame is refused before `JSON.parse` sees it.
 */
export const MAX_JSON_DEPTH = 32;

/** The first byte of every binary frame. */
export const FrameKind = {
  /** Client to server: one step of one player's input. */
  INPUT: 1,
  /** Server to client: the transform rows of one send. */
  ROWS: 2,
} as const;

/** Which lanes a transform row carries, OR-ed together in its flags byte. */
export const RowFlag = {
  /** Position: three `i32` millimetres. */
  POSITION: 1,
  /** Rotation: one `u32`, smallest-three. */
  ROTATION: 2,
  /** Scale: three `f32`, exact and signed. */
  SCALE: 4,
  /**
   * No lanes: the entity was hidden at spawn and is now shown (the server's
   * world record only ever turns visibility on). The same bit as the
   * engine's `TRANSFORM_FLAGS.VISIBLE`, so a client can pass it through.
   */
  VISIBLE: 8,
  /**
   * No lanes: the entity teleported since the last rows this player was sent;
   * snap to this pose instead of interpolating to it. The same bit as
   * `TRANSFORM_FLAGS.TELEPORT`.
   */
  TELEPORT: 16,
} as const;

/** Every flag bit a row may set; a frame with any other bit is refused. */
export const ROW_FLAG_MASK =
  RowFlag.POSITION | RowFlag.ROTATION | RowFlag.SCALE | RowFlag.VISIBLE | RowFlag.TELEPORT;

/** Bytes of an input frame: kind, seq, three key sets, mods, mouse, focused. */
export const INPUT_FRAME_BYTES = 1 + 4 + 3 * 4 * KEY_WORDS + 1 + 2 + 2 + 1 + 1 + 1 + 1 + 1;

/** Bytes of a rows frame before its first row: kind, frame, ack, count. */
export const ROWS_HEADER_BYTES = 1 + 4 + 4 + 2;

/** The most rows one frame can carry (`count` is a `u16`). */
export const MAX_ROWS = 0xffff;

/** The first byte of a rows frame's player trailer, after its last row. */
export const PLAYER_TRAILER_TAG = 1;

/**
 * Bytes of a rows frame's player trailer: tag `u8`, entity `u32`, seq `u32`,
 * position `3 x f32`, velocity `3 x f32`, flags `u8`.
 */
export const PLAYER_TRAILER_BYTES = 1 + 4 + 4 + 12 + 12 + 1;

/** What a player trailer's flags byte says about the body, OR-ed together. */
export const PlayerRowFlag = {
  /** The character body stood on walkable ground after the step. */
  GROUNDED: 1,
  /**
   * The authority teleported the body since the last rows this player was
   * sent (a respawn, a `set-body-transform` with `teleport`): a predicting
   * client snaps to it instead of counting a correction.
   */
  TELEPORT: 2,
} as const;

/** Every flag bit a player trailer may set; a frame with any other bit is refused. */
export const PLAYER_ROW_FLAG_MASK = PlayerRowFlag.GROUNDED | PlayerRowFlag.TELEPORT;
