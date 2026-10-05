/**
 * Why a Colyseus join or room ended, in the words `RoomConnection` reports
 * (`onState('closed', reason)`, and so `net.closeReason`).
 */
import { CloseCode } from '@colyseus/sdk';

import { IDLE_CLOSE_CODE } from '../channels.js';

/** Colyseus's matchmaking error codes (`@colyseus/shared-types` `ErrorCode`). */
const NO_CRITERIA = 521;
const BAD_ROOM_ID = 522;
const EXPIRED = 524;
/** The room server's `ServerError.code`s (`@gameable/rooms/server`). */
const BY_CODE: Readonly<Record<number, string>> = {
  403: 'origin',
  409: 'refused',
  426: 'version',
  429: 'busy',
  503: 'capacity',
  4212: 'no-room',
  [NO_CRITERIA]: 'no-room',
  [EXPIRED]: 'expired',
};

/**
 * @param error What a `join`, `joinById`, `joinOrCreate`, `create` or
 *   `reconnect` promise rejected with (a `ServerError` carries a `code`).
 * @returns The refusal: `'origin'` (403), `'full'` (the room is locked),
 *   `'no-room'` (no room has that code), `'no-server'` (a 404 from something
 *   other than the room server: nothing serves `/services/rooms/`), `'busy'` (429, too many tries from
 *   this address, or the address holds all the seats it may), `'capacity'` (503,
 *   the server holds all the rooms it may), `'version'` (426, the page is older
 *   or newer than the room server: reload it), `'expired'` (a reconnection token
 *   past its hold), else `'refused'` (the game's `admit` said no, among others).
 *
 * @example
 * ```ts
 * import { refusalReason } from 'gameable/rooms/client';
 * console.log(refusalReason({ code: 503, message: 'full' })); // 'capacity'
 * ```
 */
export function refusalReason(error: unknown): string {
  const { code, message } = (error ?? {}) as { code?: unknown; message?: unknown };
  if (code === 404) {
    // The room server's own miss names the code; any other 404 is no room server at that address.
    return typeof message === 'string' && message.startsWith('no room has the code')
      ? 'no-room'
      : 'no-server';
  }
  if (code === BAD_ROOM_ID) {
    return typeof message === 'string' && message.includes('locked') ? 'full' : 'no-room';
  }
  return typeof code === 'number' ? (BY_CODE[code] ?? 'refused') : 'refused';
}

/**
 * @param code The close code `room.onLeave` gave.
 * @param said The code of the room's last `error` frame, if one came: with a
 *   4002 (`WITH_ERROR`) close it is the reason (`'budget'` after an input or
 *   text flood), since the close code alone only says "error".
 * @returns The reason: `'left'` (this page left), `'shutdown'`, `'error'` (or `said`), `'idle'`
 *   (the room dropped this page for sending nothing; its seat is held, so a reload
 *   inside the hold gets it back),
 *   `'lost'` (the link dropped and could not, or was not allowed to, resume), or
 *   `'closed <code>'`.
 *
 * @example
 * ```ts
 * import { leaveReason } from 'gameable/rooms/client';
 * console.log(leaveReason(1006)); // 'lost'
 * ```
 */
export function leaveReason(code: number, said?: string): string {
  switch (code) {
    case CloseCode.CONSENTED:
      return 'left';
    case CloseCode.SERVER_SHUTDOWN:
      return 'shutdown';
    case CloseCode.WITH_ERROR:
      return said ?? 'error';
    case IDLE_CLOSE_CODE:
      return 'idle';
    case CloseCode.FAILED_TO_RECONNECT:
    case CloseCode.ABNORMAL_CLOSURE:
    case CloseCode.GOING_AWAY:
    case CloseCode.NO_STATUS_RECEIVED:
    case CloseCode.MAY_TRY_RECONNECT:
      return 'lost';
    default:
      return `closed ${String(code)}`;
  }
}
