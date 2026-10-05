/**
 * `RoomConnection` — what the client module needs from "a link to a room".
 *
 * The client never talks to a socket or to a room server's SDK directly. It
 * holds a `RoomConnection`, which delivers the server's frames exactly as the
 * protocol defines them (JSON text, and rows bytes) and carries the client's
 * frames back. Two implementations exist: `LoopbackConnection` (our own
 * frames over a `Transport`, talking to our own `Room`: Play Solo and tests)
 * and, in `gameable/rooms/client`, a Colyseus one (the SDK plus a client
 * serializer that carries the same frames behind a one-byte tag).
 *
 * Joining, seat secrets and reconnecting are the connection's business; the
 * frames are the client's.
 */

/**
 * Where a connection is:
 *
 * - `idle`: made, `join` not called yet;
 * - `connecting`: joining for the first time;
 * - `open`: a seat is held and frames flow (the `welcome` has arrived);
 * - `reconnecting`: the link dropped; the seat is held and a retry is on its
 *   way. The next `open` follows a fresh `welcome`;
 * - `closed`: final. Nothing more arrives and nothing more is sent.
 *
 * @example
 * ```ts
 * import type { ConnectionState } from 'gameable/net/client';
 * const live = (state: ConnectionState): boolean => state === 'open';
 * ```
 */
export type ConnectionState = 'idle' | 'connecting' | 'open' | 'reconnecting' | 'closed';

/**
 * Who is joining, and where.
 *
 * @example
 * ```ts
 * import type { JoinRequest } from 'gameable/net/client';
 * const request: JoinRequest = { name: 'Ana', room: 'KQTX' };
 * ```
 */
export interface JoinRequest {
  /** The display name; the server may cut it. */
  name: string;
  /** A room code; absent joins the connection's default room. */
  room?: string;
}

/**
 * What a connection reports. Every callback runs outside a fixed step (when
 * the frame arrives), so a listener queues; it never applies.
 *
 * @example
 * ```ts
 * import type { RoomConnectionEvents } from 'gameable/net/client';
 * const events: RoomConnectionEvents = {
 *   onText: (text) => console.log('text', text.length),
 *   onRows: (bytes) => console.log('rows', bytes.byteLength),
 *   onState: (state, reason) => console.log(state, reason),
 * };
 * ```
 */
export interface RoomConnectionEvents {
  /** One server text frame (`welcome`, `cmd`, `players`, `msg`, `pong`, `error`), as its JSON text. */
  onText(text: string): void;
  /**
   * One rows frame, kind byte included. The bytes are the listener's to keep:
   * a connection whose transport reuses a buffer copies before it calls this.
   */
  onRows(bytes: Uint8Array): void;
  /**
   * The state changed. These are the reconnect hooks: `reconnecting` when
   * the link drops with the seat held, `open` once a `welcome` has arrived
   * (after the first join, and again after each resume), and `closed` once,
   * at the end. `reason` names why (`'lost'`, a server error code such as
   * `'full'` or `'seat'`, or the reason given to `leave`); it is `''` when
   * there is nothing to say.
   */
  onState(state: ConnectionState, reason: string): void;
}

/**
 * A link to one room seat, whatever carries it.
 *
 * @example
 * ```ts
 * import { createLoopbackConnection, type RoomConnection } from 'gameable/net/client';
 * import { loopbackPair } from 'gameable/net/testing';
 *
 * const connection: RoomConnection = createLoopbackConnection({
 *   connect: () => loopbackPair()[0],
 * });
 * connection.join({ name: 'Ana' }, {
 *   onText: (text) => console.log(text),
 *   onRows: () => undefined,
 *   onState: (state) => console.log(state),
 * });
 * ```
 */
export interface RoomConnection {
  /** Where the connection is now. */
  readonly state: ConnectionState;
  /**
   * The code of the room joined, as the server assigned it (a join without a
   * code, or "new", learns it here), or null before the welcome or when the
   * server does not say.
   */
  readonly room: string | null;
  /**
   * Start joining. Call once; frames and state changes go to `events` from
   * then on.
   */
  join(request: JoinRequest, events: RoomConnectionEvents): void;
  /**
   * Send one INPUT frame (`encodeInput`'s bytes). Dropped unless `open`. The
   * caller may reuse the buffer after the call: a connection that queues
   * copies first.
   */
  sendInput(bytes: Uint8Array): void;
  /** Send one client text frame (`msg` or `ping`; never `hello`). Dropped unless `open`. */
  sendText(text: string): void;
  /**
   * Drop the link now and resume this seat, as after a lost link: the state
   * becomes `reconnecting`, and `open` again after a fresh `welcome`. The
   * client asks for it when its queues overflowed or the link went silent.
   * Ignored unless `open`.
   *
   * @param reason Why (`'resync'`, `'silent'`), as the `reconnecting` state reports it.
   */
  reconnect(reason: string): void;
  /** Leave the room for good: no retry follows. The state becomes `closed` with `reason`. */
  leave(reason?: string): void;
}
