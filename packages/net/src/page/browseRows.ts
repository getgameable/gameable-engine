/**
 * What the browse panel shows for each public room, in the order it shows them.
 */
import type { PublicRoom } from './roomList.js';

/**
 * One row of the browse panel, as plain text.
 *
 * @example
 * ```ts
 * import type { BrowseRow } from 'gameable/net/page';
 * const row: BrowseRow = { code: 'KQTX', seats: '2/6', phase: 'lobby', full: false };
 * ```
 */
export interface BrowseRow {
  /** The room code. */
  readonly code: string;
  /** Seats taken out of seats, `2/6`. */
  readonly seats: string;
  /** The game's phase, or `—` when it says none. */
  readonly phase: string;
  /** No seat left: the row's Join is disabled. */
  readonly full: boolean;
}

/**
 * The panel's rows: rooms with a free seat first, the fullest of those first
 * (a game is more fun with people in it), then by code so the order holds
 * still between updates.
 *
 * @param rooms The live list's rooms.
 * @returns One row per room.
 *
 * @example
 * ```ts
 * import { browseRows } from 'gameable/net/page';
 *
 * browseRows([{ code: 'KQTX', players: 2, maxPlayers: 6, phase: null }]);
 * // [{ code: 'KQTX', seats: '2/6', phase: '—', full: false }]
 * ```
 */
export function browseRows(rooms: readonly PublicRoom[]): BrowseRow[] {
  return rooms
    .map((room) => ({ room, full: room.players >= room.maxPlayers }))
    .sort(
      (a, b) =>
        Number(a.full) - Number(b.full) ||
        b.room.players - a.room.players ||
        (a.room.code < b.room.code ? -1 : a.room.code > b.room.code ? 1 : 0),
    )
    .map(({ room, full }) => ({
      code: room.code,
      seats: `${String(room.players)}/${String(room.maxPlayers)}`,
      phase: room.phase ?? '—',
      full,
    }));
}
