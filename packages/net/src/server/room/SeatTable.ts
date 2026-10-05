/**
 * `SeatTable` — a room's seats, ascending by id, and which connection holds which.
 */
import type { PlayerSummary } from '../../protocol/types.js';
import type { TextLimitOptions } from '../inbound/TextLimit.js';
import { RoomPlayer } from './RoomPlayer.js';

/**
 * The seats of one room. Ids are 0 upward; a new seat takes the lowest free
 * id; `list` stays ascending, so a tick walks players in id order.
 *
 * @example
 * ```ts
 * import { SeatTable } from 'gameable/net/server';
 *
 * const seats = new SeatTable();
 * const ana = seats.add('secret', 'Ana', 'conn-1', 0);
 * seats.byConn('conn-1') === ana; // true
 * ```
 */
export class SeatTable {
  /** Every seat, held ones included, ascending by id. */
  readonly list: RoomPlayer[] = [];
  private readonly conns = new Map<string, RoomPlayer>();

  /** @param text The text limit every new seat gets (`RoomPlayer.text`). */
  constructor(private readonly text?: TextLimitOptions) {}

  /** @returns How many seats are taken, held ones included. */
  get size(): number {
    return this.list.length;
  }

  /**
   * @param conn A connection id.
   * @returns The seat it holds, if any.
   */
  byConn(conn: string): RoomPlayer | undefined {
    return this.conns.get(conn);
  }

  /**
   * @param id A player id.
   * @returns That seat, if taken.
   */
  byId(id: number): RoomPlayer | undefined {
    for (const seat of this.list) if (seat.id === id) return seat;
    return undefined;
  }

  /**
   * Take a new seat at the lowest free id.
   *
   * @param secret Its secret.
   * @param name Its display name.
   * @param conn The connection taking it.
   * @param now The room's clock.
   * @returns The seat.
   */
  add(secret: string, name: string, conn: string, now: number): RoomPlayer {
    let id = 0;
    let at = 0;
    while (at < this.list.length && this.list[at].id === id) {
      id += 1;
      at += 1;
    }
    const seat = new RoomPlayer(id, secret, name, conn, now, this.text);
    this.list.splice(at, 0, seat);
    this.conns.set(conn, seat);
    return seat;
  }

  /**
   * Hand a seat to a connection (a resume).
   *
   * @param seat The seat.
   * @param conn The connection now holding it.
   * @param now The room's clock.
   */
  attach(seat: RoomPlayer, conn: string, now: number): void {
    if (seat.conn !== null) this.conns.delete(seat.conn);
    seat.conn = conn;
    seat.lastSeen = now;
    this.conns.set(conn, seat);
  }

  /**
   * The connection is gone; the seat is held.
   *
   * @param conn The connection.
   * @param now The room's clock.
   * @returns The seat it held, if any.
   */
  detach(conn: string, now: number): RoomPlayer | undefined {
    const seat = this.conns.get(conn);
    if (seat === undefined) return undefined;
    this.conns.delete(conn);
    seat.conn = null;
    seat.lastSeen = now;
    return seat;
  }

  /**
   * Free a seat.
   *
   * @param seat The seat.
   */
  remove(seat: RoomPlayer): void {
    const at = this.list.indexOf(seat);
    if (at >= 0) this.list.splice(at, 1);
    if (seat.conn !== null) this.conns.delete(seat.conn);
  }

  /** @returns Every seat as the `players` frame lists them. */
  summaries(): PlayerSummary[] {
    return this.list.map((seat) => seat.summary());
  }
}
