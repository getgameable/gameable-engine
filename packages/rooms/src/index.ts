/**
 * `gameable/rooms` — multiplayer rooms on Colyseus.
 *
 * This entry imports nothing: it is the wire channels the room server
 * (`gameable/rooms/server`) and the client (`gameable/rooms/client`)
 * share. Nothing outside this package imports `@colyseus/*`.
 */

/**
 * How our frames ride Colyseus: the byte in front of each server frame, the
 * serializer id, and the `sendBytes` types of client frames.
 *
 * @example
 * ```ts
 * import { INPUT_TYPE, ROOM_STATE, ROOM_STATE_PATCH, TEXT_FIRST_BYTE } from 'gameable/rooms';
 *
 * const frame = new Uint8Array([ROOM_STATE_PATCH, TEXT_FIRST_BYTE]);
 * const isWelcome = frame[0] === ROOM_STATE; // false
 * const isText = frame[1] === TEXT_FIRST_BYTE; // true: a cmd, msg, players, pong or error
 * console.log(INPUT_TYPE, isWelcome, isText); // room.sendBytes(INPUT_TYPE, inputFrame) on the client
 * ```
 */
export {
  IDENTITY_TYPE,
  IDLE_CLOSE_CODE,
  INPUT_TYPE,
  ROOM_STATE,
  ROOM_STATE_PATCH,
  SERIALIZER_ID,
  TEXT_FIRST_BYTE,
  TEXT_TYPE,
} from './channels.js';
