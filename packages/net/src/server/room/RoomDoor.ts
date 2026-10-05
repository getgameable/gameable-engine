/**
 * `RoomDoor` — how a connection gets a seat: version, admission, a new seat
 * or a resumed one, and the welcome.
 */
import { PROTOCOL_VERSION } from '../../protocol/constants.js';
import type { ClientText } from '../../protocol/types.js';
import type { RoomGame } from './RoomGame.js';
import type { RoomPlayer } from './RoomPlayer.js';
import type { RoomPorts } from './RoomPorts.js';
import type { RoomWire } from './RoomWire.js';
import type { SeatTable } from './SeatTable.js';
import { newSeatSecret } from './seatSecret.js';

/** A `hello` frame. */
export type Hello = Extract<ClientText, { t: 'hello' }>;

/**
 * The room's door. A `hello` with no seat is checked against the version,
 * the seat count and the game's `admit` hook (held while it runs), then
 * seated at the lowest free id (0 upward) and welcomed. A `hello` with a
 * seat resumes it when the secret matches (`ports.equalSecrets`, else `===`),
 * dropping any connection still holding it. Refusals are `error` frames
 * followed by a drop.
 *
 * @example
 * ```ts
 * import { RoomDoor } from 'gameable/net/server';
 *
 * const door = new RoomDoor(game, ports, seats, wire, 8, 'KQTX');
 * door.hello('conn-1', { t: 'hello', v: 1, room: 'KQTX', name: 'Ana' });
 * ```
 */
export class RoomDoor {
  private readonly admitting = new Set<string>();
  private shut = false;

  /**
   * @param game The room's game.
   * @param ports The room's ports.
   * @param seats The room's seats.
   * @param wire Where frames are built and sent.
   * @param maxPlayers Seats, held ones included.
   * @param code The room's code, named in every welcome.
   */
  constructor(
    private readonly game: RoomGame,
    private readonly ports: RoomPorts,
    private readonly seats: SeatTable,
    private readonly wire: RoomWire,
    private readonly maxPlayers: number,
    private readonly code: string,
  ) {}

  /**
   * @param conn A connection.
   * @returns True while its `admit` check is running.
   */
  isAdmitting(conn: string): boolean {
    return this.admitting.has(conn);
  }

  /** @param conn A connection that closed; a pending admission is abandoned. */
  forget(conn: string): void {
    this.admitting.delete(conn);
  }

  /**
   * The room is ending: every connection still waiting on `admit` gets
   * `error: ended` and is dropped; later verdicts are ignored.
   *
   * @param detail The `error` detail, if any.
   */
  shutAll(detail: string | undefined): void {
    this.shut = true;
    for (const conn of this.admitting) {
      this.wire.error(conn, 'ended', detail);
      this.ports.drop(conn, 'ended');
    }
    this.admitting.clear();
  }

  /**
   * Seat a newcomer or resume a held seat.
   *
   * @param conn The connection.
   * @param hello Its `hello`.
   */
  hello(conn: string, hello: Hello): void {
    if (hello.v !== PROTOCOL_VERSION) {
      this.refuse(conn, 'version', `server speaks ${String(PROTOCOL_VERSION)}`);
      return;
    }
    if (hello.seat !== undefined) {
      this.resume(conn, hello.seat.id, hello.seat.secret);
      return;
    }
    if (this.seats.size >= this.maxPlayers) {
      this.refuse(conn, 'full');
      return;
    }
    const verdict = this.game.admit?.(hello.name, hello.token);
    if (verdict === undefined) {
      this.seat(conn, hello.name, hello.token);
      return;
    }
    this.admitting.add(conn);
    verdict
      .then((refusal) => {
        if (!this.admitting.delete(conn) || this.shut) return;
        if (refusal !== null) this.refuse(conn, 'room', refusal);
        else if (this.seats.size >= this.maxPlayers) this.refuse(conn, 'full');
        else this.seat(conn, hello.name, hello.token);
      })
      .catch((error: unknown) => {
        if (!this.admitting.delete(conn) || this.shut) return;
        this.ports.log('room.admit-failed', { conn, error: String(error) });
        this.refuse(conn, 'room', 'admission failed');
      });
  }

  /** @param except A seat not to tell (it was just welcomed with the list). */
  announce(except?: RoomPlayer): void {
    const summaries = this.seats.summaries();
    for (const seat of this.seats.list) {
      if (seat === except || seat.conn === null) continue;
      this.wire.players(seat.conn, summaries);
    }
  }

  /**
   * @param conn The connection.
   * @param name The newcomer's name.
   * @param token The `hello` token, logged as present or not, never kept.
   */
  private seat(conn: string, name: string, token: string | undefined): void {
    const seat = this.seats.add(newSeatSecret(() => this.ports.random()), name, conn, this.ports.now());
    this.ports.log('room.join', { player: seat.id, token: token !== undefined });
    this.game.join(seat.id, name, null);
    this.welcome(seat);
  }

  /**
   * @param conn The connection.
   * @param id The seat id it claims.
   * @param secret The secret it sent.
   */
  private resume(conn: string, id: number, secret: string): void {
    const seat = this.seats.byId(id);
    const equal =
      seat !== undefined && (this.ports.equalSecrets?.(seat.secret, secret) ?? seat.secret === secret);
    if (seat === undefined || !equal) {
      this.refuse(conn, 'seat');
      return;
    }
    const old = seat.conn;
    if (old !== null && old !== conn) this.ports.drop(old, 'replaced');
    this.seats.attach(seat, conn, this.ports.now());
    if (old === null) this.game.resume?.(seat.id); // it was held
    this.ports.log('room.resume', { player: seat.id });
    this.welcome(seat);
  }

  /** @param seat The seat just taken or resumed: its welcome, then the list to the others. */
  private welcome(seat: RoomPlayer): void {
    const conn = seat.conn;
    if (conn === null) return;
    seat.lastRowsAt = Number.NEGATIVE_INFINITY;
    const snapshot = this.game.snapshotFor(seat.id);
    const entity = this.game.entityOf?.(seat.id) ?? 0;
    const players = this.seats.summaries();
    this.wire.welcome(conn, seat.id, entity, seat.secret, this.game.frame, snapshot, players, this.code);
    this.announce(seat);
  }

  /**
   * @param conn The connection.
   * @param code Why.
   * @param detail Words for the page.
   */
  private refuse(conn: string, code: 'version' | 'full' | 'room' | 'seat', detail?: string): void {
    this.wire.error(conn, code, detail);
    this.ports.drop(conn, code);
    this.ports.log('room.refuse', { conn, code });
  }
}
