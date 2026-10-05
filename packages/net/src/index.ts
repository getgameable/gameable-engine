/**
 * `gameable/net` — multiplayer's wire protocol and transport interface.
 *
 * This entry has no DOM, no `ws` and no three: it is the frames and codecs
 * both the client and the server speak.
 */

/**
 * The protocol's fixed numbers: the version `hello` carries, the payload,
 * client text and nesting caps, and the byte sizes of the binary frames.
 *
 * @example
 * ```ts
 * import { INPUT_FRAME_BYTES, PROTOCOL_VERSION } from 'gameable/net';
 * const hello = { t: 'hello', v: PROTOCOL_VERSION, room: 'lobby', name: 'Ana' } as const;
 * const out = new DataView(new ArrayBuffer(INPUT_FRAME_BYTES));
 * ```
 */
export {
  AUTHORITY_SENDER,
  INPUT_FRAME_BYTES,
  MAX_CLIENT_TEXT_BYTES,
  MAX_JSON_DEPTH,
  MAX_PAYLOAD_BYTES,
  MAX_ROWS,
  PROTOCOL_VERSION,
  ROW_FLAG_MASK,
  ROWS_HEADER_BYTES,
} from './protocol/index.js';
/**
 * The first byte of a binary frame, and the lane bits of a transform row.
 *
 * @example
 * ```ts
 * import { FrameKind, RowFlag } from 'gameable/net';
 * const bytes = new Uint8Array([FrameKind.ROWS]);
 * const isRows = bytes[0] === FrameKind.ROWS; // true
 * const flags = RowFlag.POSITION | RowFlag.ROTATION;
 * ```
 */
export { FrameKind, RowFlag } from './protocol/index.js';
/**
 * A rows frame's player trailer: the receiving player's own body (position,
 * velocity, grounded, teleported) and the input seq it follows, for
 * client-side prediction. Absent for a spectator.
 *
 * @example
 * ```ts
 * import { decodeRows, PlayerRowFlag, type PlayerRow, type RowSink } from 'gameable/net';
 * declare const frame: Uint8Array;
 * const sink: RowSink = {
 *   position: new Float32Array(3),
 *   rotation: new Float32Array(4),
 *   scale: new Float32Array(3),
 *   row: () => undefined,
 *   player: (me: PlayerRow) => console.log(me.seq, me.position, (me.flags & PlayerRowFlag.GROUNDED) !== 0),
 * };
 * decodeRows(frame, sink);
 * ```
 */
export {
  PLAYER_ROW_FLAG_MASK,
  PLAYER_TRAILER_BYTES,
  PLAYER_TRAILER_TAG,
  PlayerRowFlag,
} from './protocol/index.js';
/**
 * Input frames: one step of one player's input, client to server.
 *
 * @example
 * ```ts
 * import { KEY_WORDS } from 'gameable/sdk/keycodes';
 * import { decodeInput, encodeInput, INPUT_FRAME_BYTES, type MutableInputSnapshot } from 'gameable/net';
 * const blank = (): MutableInputSnapshot => ({
 *   down: new Uint32Array(KEY_WORDS),
 *   pressed: new Uint32Array(KEY_WORDS),
 *   released: new Uint32Array(KEY_WORDS),
 *   mods: { shift: false, ctrl: false, alt: false, meta: false, capsLock: false, numLock: false },
 *   mouse: { dx: 0, dy: 0, wheel: 0, buttons: 0, pressed: 0, released: 0 },
 *   focused: true,
 * });
 * const snapshot = blank();
 * snapshot.mouse.dx = -12;
 * const into = blank();
 * const out = new DataView(new ArrayBuffer(INPUT_FRAME_BYTES));
 * const bytes = encodeInput(out, 1, snapshot);
 * const header = decodeInput(new Uint8Array(out.buffer, 0, bytes), into); // { seq: 1 }, into.mouse.dx === -12
 * ```
 */
export { createInputCodec, decodeInput, encodeInput, InputCodec } from './protocol/index.js';
/**
 * Rows frames: the transform rows of one send, server to client.
 *
 * @example
 * ```ts
 * import { decodeRows, encodeRows, RowFlag, rowsFrameBytes, type RowSink, type RowSource } from 'gameable/net';
 * const position = new Float32Array([1.5, 0, -2]);
 * const rotation = new Float32Array([0, 0, 0, 1]);
 * const scale = new Float32Array([-1, 1, 1]);
 * const rows: RowSource = {
 *   count: 1,
 *   entity: () => 7,
 *   flags: () => RowFlag.POSITION | RowFlag.ROTATION | RowFlag.SCALE,
 *   position: () => position,
 *   rotation: () => rotation,
 *   scale: () => scale,
 * };
 * const sink: RowSink = {
 *   position: new Float32Array(3),
 *   rotation: new Float32Array(4),
 *   scale: new Float32Array(3),
 *   row: (entity, flags) => console.log(entity, flags, sink.position, sink.scale),
 * };
 * const out = new DataView(new ArrayBuffer(rowsFrameBytes(rows)));
 * const bytes = encodeRows(out, 600, 12, rows);
 * decodeRows(new Uint8Array(out.buffer, 0, bytes), sink); // { frame: 600, ack: 12, count: 1, player: null }
 * ```
 */
export {
  createRowsCodec,
  decodeRows,
  encodeRows,
  RowsCodec,
  rowsFrameBytes,
} from './protocol/index.js';
/**
 * Transform quantisation: millimetre positions, smallest-three rotations.
 *
 * @example
 * ```ts
 * import { packQuat, unpackQuat } from 'gameable/net';
 * const q = new Float32Array(4);
 * unpackQuat(packQuat(0, 0, Math.SQRT1_2, Math.SQRT1_2), q, 0);
 * ```
 */
export { packQuat, Quantizer, unpackQuat } from './protocol/index.js';
/**
 * JSON text frames: `hello`, `msg` and `ping` from a client; `welcome`, `cmd`,
 * `players`, `msg`, `pong` and `error` from the server.
 *
 * @example
 * ```ts
 * import { buildClientText, parseClientText } from 'gameable/net';
 * const text = buildClientText({ t: 'msg', name: 'chat', payload: { text: 'hi' } });
 * const frame = text === null ? null : parseClientText(text);
 * ```
 */
export {
  buildClientText,
  buildServerText,
  createTextFrames,
  parseClientText,
  parseServerText,
  TextFrames,
  utf8ByteLength,
} from './protocol/index.js';
/**
 * The base the binary codecs share: bounds-checked little-endian reads.
 *
 * @example
 * ```ts
 * import { FrameCodec } from 'gameable/net';
 * class PingCodec extends FrameCodec {
 *   decode(bytes: Uint8Array): number | null {
 *     return this.isKind(bytes, 9, 5) ? this.u32(bytes, 1) : null;
 *   }
 * }
 * new PingCodec().decode(new Uint8Array([9, 1, 0, 0, 0])); // 1
 * ```
 */
export { FrameCodec } from './protocol/index.js';
export type {
  ClientText,
  InputHeader,
  InputSnapshotLike,
  MutableInputSnapshot,
  PlayerRow,
  PlayerRowSource,
  PlayerSummary,
  RowSink,
  RowSource,
  RowsHeader,
  ServerErrorCode,
  ServerText,
  WireMods,
  WireMouse,
} from './protocol/index.js';

/**
 * The transport interface: one socket-shaped pipe of text and binary frames.
 *
 * @example
 * ```ts
 * import type { Transport } from 'gameable/net';
 * import { loopbackPair } from 'gameable/net/testing';
 * const [client, server]: [Transport, Transport] = loopbackPair();
 * server.onMessage((data) => console.log(data));
 * client.send('{"t":"ping","n":1}');
 * ```
 */
export type { Transport, TransportData } from './transport/index.js';
/**
 * The base class every transport extends: listener lists and the closed latch.
 *
 * @example
 * ```ts
 * import { BaseTransport } from 'gameable/net';
 * class Echo extends BaseTransport {
 *   readonly bufferedAmount = 0;
 *   send(data: string | Uint8Array): void {
 *     if (!this.isClosed) this.deliver(data);
 *   }
 *   protected shutdown(): void {}
 * }
 * const echo = new Echo();
 * echo.onMessage((data) => console.log(data));
 * echo.send('hello');
 * ```
 */
export { BaseTransport } from './transport/index.js';
