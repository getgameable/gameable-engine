/**
 * `SeatClaim` — one connection's hold on its seat: the saved token (this
 * tab's `sessionStorage`) and the seat's lock (shared by the browser's tabs).
 */
import { type SeatLocks, webSeatLocks } from './SeatLocks.js';
import { type SavedSeat, type SeatStorage, SeatTokens } from './SeatTokens.js';

/**
 * Tokens plus locks for one `ColyseusConnection`.
 *
 * - `resumable(code)`: the saved token for a code, but only once this tab has
 *   the seat's lock. A busy lock means another live tab (the original of a
 *   duplicated one) sits in that seat: the copied token is forgotten and the
 *   caller joins as a new player.
 * - `hold(code, sessionId)`: take the lock for a seat just joined.
 * - `save` at each welcome: the token Colyseus issued for this join or resume.
 * - `unlock()` when the connection closes.
 *
 * @example
 * ```ts
 * import { SeatClaim } from 'gameable/rooms/client';
 * const claim = new SeatClaim('wss://play.example/services/rooms/', 'party');
 * const saved = await claim.resumable('KQTX'); // null: nothing saved
 * ```
 */
export class SeatClaim {
  private readonly tokens: SeatTokens;
  private readonly locks: SeatLocks | null;
  private release: (() => void) | null = null;

  /**
   * @param url The room server.
   * @param game The catalog game.
   * @param storage Where tokens live. Default `sessionStorage`; null keeps none.
   * @param locks The seat locks. Default `navigator.locks`; null takes none.
   */
  constructor(url: string, game: string, storage?: SeatStorage | null, locks?: SeatLocks | null) {
    this.tokens = new SeatTokens(url, game, storage);
    this.locks = locks === undefined ? webSeatLocks() : locks;
  }

  /**
   * @param code A room code.
   * @returns The seat to resume, its lock now held; or null (nothing saved, or another tab holds it).
   */
  async resumable(code: string): Promise<SavedSeat | null> {
    const saved = this.tokens.load(code);
    if (saved === null) return null;
    if (!(await this.take(code, saved.sessionId))) {
      this.tokens.forget(code); // a copy of a live tab's token: never ours to use
      return null;
    }
    return saved;
  }

  /**
   * @param code The room joined.
   * @param sessionId Its session.
   */
  async hold(code: string, sessionId: string): Promise<void> {
    if (this.release === null) await this.take(code, sessionId);
  }

  /**
   * @param code The room.
   * @param seat The session and its newest token.
   */
  save(code: string, seat: SavedSeat): void {
    this.tokens.save(code, seat);
  }

  /** @param code A room whose seat is gone: its token goes. */
  forget(code: string): void {
    this.tokens.forget(code);
  }

  /** Let go of the seat's lock (the connection closed, or a resume failed). */
  unlock(): void {
    const release = this.release;
    this.release = null;
    release?.();
  }

  /**
   * @param code The room.
   * @param sessionId The seat.
   * @returns True when this tab now holds the seat's lock (always, without locks).
   */
  private async take(code: string, sessionId: string): Promise<boolean> {
    if (this.locks === null) return true;
    const release = await this.locks.tryHold(`${this.tokens.key(code)}|${sessionId}`);
    if (release === null) return false;
    this.unlock();
    this.release = release;
    return true;
  }
}
