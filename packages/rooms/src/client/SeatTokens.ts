/**
 * `SeatTokens` — the SDK's reconnection token for each room this tab sits
 * in, kept in `sessionStorage` (never `localStorage`): a reload of the same
 * tab gets its seat back, and a second tab is a second player.
 */

/**
 * The part of the Web Storage API the tokens need; `sessionStorage` is one.
 *
 * @example
 * ```ts
 * import type { SeatStorage } from 'gameable/rooms/client';
 * const storage: SeatStorage = sessionStorage;
 * ```
 */
export interface SeatStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** @returns This tab's `sessionStorage`, or null where there is none (Node) or it is blocked. */
function tabStorage(): SeatStorage | null {
  try {
    return (globalThis as { sessionStorage?: SeatStorage }).sessionStorage ?? null;
  } catch {
    return null; // a sandboxed frame throws on the getter
  }
}

/**
 * A seat this tab held: its Colyseus session (stable across resumes, so it
 * names the seat's lock) and its latest reconnection token.
 *
 * @example
 * ```ts
 * import type { SavedSeat } from 'gameable/rooms/client';
 * const seat: SavedSeat = { sessionId: 'aB3', token: 'KQTX:abc' };
 * ```
 */
export interface SavedSeat {
  readonly sessionId: string;
  readonly token: string;
}

/**
 * Reconnection tokens by room, under the key
 * `gameable.rooms|<server url>|<game>|<room code>`, stored as
 * `<sessionId> <token>`. Storage failures (full, blocked) are ignored:
 * without a token a reload joins as a new player.
 *
 * @example
 * ```ts
 * import { SeatTokens } from 'gameable/rooms/client';
 * const tokens = new SeatTokens('wss://play.example/services/rooms/', 'party');
 * tokens.save('KQTX', { sessionId: 'aB3', token: 'KQTX:abc' });
 * console.log(tokens.load('KQTX')); // { sessionId: 'aB3', token: 'KQTX:abc' }
 * ```
 */
export class SeatTokens {
  private readonly storage: SeatStorage | null;

  /**
   * @param url The room server.
   * @param game The catalog game.
   * @param storage Where to keep them. Default this tab's `sessionStorage`; null keeps none.
   */
  constructor(
    private readonly url: string,
    private readonly game: string,
    storage?: SeatStorage | null,
  ) {
    this.storage = storage === undefined ? tabStorage() : storage;
  }

  /**
   * @param room A room code.
   * @returns The seat saved for it, or null.
   */
  load(room: string): SavedSeat | null {
    let value: string | null;
    try {
      value = this.storage?.getItem(this.key(room)) ?? null;
    } catch {
      return null;
    }
    const space = value?.indexOf(' ') ?? -1;
    if (value === null || space <= 0) return null;
    return { sessionId: value.slice(0, space), token: value.slice(space + 1) };
  }

  /**
   * @param room A room code.
   * @param seat The session and `room.reconnectionToken`.
   */
  save(room: string, seat: SavedSeat): void {
    try {
      this.storage?.setItem(this.key(room), `${seat.sessionId} ${seat.token}`);
    } catch {
      // full or blocked: a reload joins as a new player
    }
  }

  /** @param room A room code whose seat is gone. */
  forget(room: string): void {
    try {
      this.storage?.removeItem(this.key(room));
    } catch {
      // blocked: nothing was saved either
    }
  }

  /**
   * @param room A room code.
   * @returns Its storage key; with the session appended, the seat's lock name.
   */
  key(room: string): string {
    return `gameable.rooms|${this.url}|${this.game}|${room}`;
  }
}
