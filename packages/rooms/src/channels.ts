/**
 * How our frames ride the Colyseus protocol. Shared by the room server and
 * the client, so it imports nothing.
 *
 * Server to client, each of our frames goes out verbatim behind ONE Colyseus
 * byte, through our serializer:
 * - `ROOM_STATE` (14) + our `welcome` text (UTF-8), from
 *   `Serializer.getFullState(client)` right after the JOIN ack, on a first
 *   join and on every reconnect;
 * - `ROOM_STATE_PATCH` (15) + one of our other frames: a rows binary frame
 *   (first byte `FrameKind.ROWS`, 2) or a text frame (`cmd`, `msg`,
 *   `players`, `pong`, `error`; first byte `{`, `TEXT_FIRST_BYTE`).
 *
 * Client to server, through `room.sendBytes(type, bytes)` (Colyseus
 * `ROOM_DATA_BYTES`, whose header is the type string):
 * - `INPUT_TYPE` + our INPUT binary frame;
 * - `TEXT_TYPE` + our client text frame (`msg`, `ping`) as UTF-8. There is
 *   no `hello`: the join options carry the name, and Colyseus's
 *   reconnection token replaces the seat secret.
 */

/** Colyseus `Protocol.ROOM_STATE`: the byte in front of our welcome. */
export const ROOM_STATE = 14;
/** Colyseus `Protocol.ROOM_STATE_PATCH`: the byte in front of every other server frame. */
export const ROOM_STATE_PATCH = 15;
/** The serializer id both sides register. */
export const SERIALIZER_ID = 'aos';
/** `sendBytes` type of an INPUT frame. */
export const INPUT_TYPE = 'i';
/** `sendBytes` type of a client text frame. */
export const TEXT_TYPE = 't';
/**
 * The Colyseus message (`client.send(type, token)`, `room.onMessage`) that
 * hands the page a fresh device token after a join whose own was missing or
 * did not verify. It follows the welcome; the page keeps it in
 * `localStorage` and sends it as the `device` join option from then on.
 */
export const IDENTITY_TYPE = 'id';
/** The first byte of a text frame (`{`); a rows frame starts with `FrameKind.ROWS`. */
export const TEXT_FIRST_BYTE = 0x7b;
/**
 * The close code of a client the room dropped for sending no frame for its
 * `idleSeconds`. Not one the SDK resumes by itself: the seat is held as after
 * any drop, and a reload inside the hold gets it back.
 */
export const IDLE_CLOSE_CODE = 4100;
