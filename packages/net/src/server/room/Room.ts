/**
 * `Room` — input intake and the tick, over a {@link RoomGame}; seating is
 * the {@link RoomDoor}'s. The host hands it every frame (`handle`) and every
 * close (`disconnect`). Each tick at `tickHz` (60): coalesced input to the
 * game, the game ticks, then every seat's view is taken (held seats' are
 * discarded) and connected seats get a `cmd` frame (every tick: it carries
 * the frame and the ack), the view's `msg` frames, and every `1000 / sendHz`
 * ms a rows frame when some pose changed. Each seat's text frames spend its
 * `RoomPlayer.text` limit before they are parsed (Task 4.2).
 */
import { InboundParser } from '../inbound/InboundParser.js';
import type { TextCounts } from '../inbound/TextLimit.js';
import { RoomClock } from './RoomClock.js';
import { RoomDoor } from './RoomDoor.js';
import type { RoomGame } from './RoomGame.js';
import type { RoomPlayer } from './RoomPlayer.js';
import type { RoomOptions, RoomPorts } from './RoomPorts.js';
import { RoomWire } from './RoomWire.js';
import { SeatTable } from './SeatTable.js';

/**
 * One room: its seats and its clock.
 *
 * @example
 * ```ts
 * import { createRoom } from 'gameable/net/server';
 *
 * const room = createRoom({ code: 'KQTX', game, ports, maxPlayers: 8, sendHz: 20 });
 * room.handle('conn-1', '{"t":"hello","v":1,"room":"KQTX","name":"Ana"}');
 * ```
 */
export class Room {
  /** The room's code. */
  readonly code: string;
  private readonly game: RoomGame;
  private readonly ports: RoomPorts;
  private readonly rowsEveryMs: number;
  private readonly leaveAfterMs: number;
  private readonly seats: SeatTable;
  private readonly parser = new InboundParser();
  private readonly wire: RoomWire;
  private readonly door: RoomDoor;
  private readonly clock: RoomClock;
  private closed = false;

  /** @param options Code, game, ports, seats and rates; see {@link RoomOptions}. */
  constructor(options: RoomOptions) {
    this.code = options.code;
    this.game = options.game;
    this.ports = options.ports;
    this.rowsEveryMs = 1000 / options.sendHz;
    this.leaveAfterMs = options.leaveAfterMs ?? 600_000;
    this.seats = new SeatTable(options.text);
    this.wire = new RoomWire(this.ports);
    this.door = new RoomDoor(this.game, this.ports, this.seats, this.wire, seatCount(options), this.code);
    this.clock = new RoomClock(this.ports, 1000 / (options.tickHz ?? 60), () => {
      this.tick();
    });
  }

  /** @returns Every seat, held ones included, ascending by id (0 upward). */
  get players(): readonly RoomPlayer[] {
    return this.seats.list;
  }

  /**
   * @param player A player id.
   * @returns What that seat's text frames came to, or undefined for no such seat.
   */
  textCounts(player: number): Readonly<TextCounts> | undefined {
    return this.seats.byId(player)?.text.counts;
  }

  /**
   * One frame from one connection. A seated connection's text frame spends
   * its text budget first; one over budget never reaches the parser.
   *
   * @param conn The connection id the host chose.
   * @param frame A text frame or a binary frame, as received.
   */
  handle(conn: string, frame: string | Uint8Array): void {
    if (this.closed) return;
    const seat = this.seats.byConn(conn);
    const text = typeof frame === 'string';
    if (text && seat !== undefined && !this.withinBudget(seat, conn)) return;
    const parsed = this.parser.parse(frame);
    if (parsed.kind === 'bad') {
      if (text) seat?.text.refused(parsed.reason);
      this.ports.log('room.bad-frame', { conn, reason: parsed.reason });
    } else if (parsed.kind === 'input') {
      seat?.absorb(parsed.seq, parsed.snapshot);
    } else if (parsed.msg.t === 'hello') {
      if (seat === undefined && !this.door.isAdmitting(conn)) this.door.hello(conn, parsed.msg);
    } else if (seat === undefined) {
      this.ports.log('room.unseated', { conn });
    } else if (parsed.msg.t === 'msg') {
      this.game.message(seat.id, parsed.msg.name, JSON.stringify(parsed.msg.payload));
    } else {
      this.wire.pong(conn, parsed.msg.at, this.ports.now());
    }
  }

  /**
   * Spend a text token. Out of budget: `error: budget` on the first refusal
   * of a run, quiet drops after it, and on sustained abuse the seat goes at
   * once, unheld, with `leave(player, 'budget')`.
   *
   * @param seat The sender's seat.
   * @param conn Its connection.
   * @returns True when the frame may be parsed.
   */
  private withinBudget(seat: RoomPlayer, conn: string): boolean {
    const verdict = seat.text.spend(this.ports.now());
    if (verdict === 'pass') return true;
    if (verdict === 'tell') this.wire.error(conn, 'budget');
    if (verdict !== 'close') return false;
    this.seats.remove(seat);
    this.ports.drop(conn, 'budget');
    this.ports.log('room.leave', { player: seat.id, reason: 'budget' });
    this.game.leave(seat.id, 'budget');
    this.door.announce();
    return false;
  }

  /**
   * A connection closed. Its seat is held for `leaveAfterMs`.
   *
   * @param conn The connection id.
   */
  disconnect(conn: string): void {
    this.door.forget(conn);
    const seat = this.seats.detach(conn, this.ports.now());
    if (seat === undefined) return;
    this.ports.log('room.disconnect', { player: seat.id });
    this.game.hold?.(seat.id);
    this.door.announce();
  }

  /**
   * End the room: `error: ended` to everyone, seated or still being
   * admitted (with `reason` as the detail unless it is `ended`), drop them,
   * stop the clock, dispose the game.
   *
   * @param reason Why: `ended`, `idle`, `crashed`...
   */
  close(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    this.clock.stop();
    const detail = reason === 'ended' ? undefined : reason;
    this.door.shutAll(detail);
    for (const seat of this.seats.list) {
      const conn = seat.conn;
      if (conn === null) continue;
      this.wire.error(conn, 'ended', detail);
      this.ports.drop(conn, 'ended');
    }
    this.ports.log('room.close', { code: this.code, reason });
    this.game.dispose();
  }

  /**
   * One room tick. The room's timer calls it; a host may call it to step by
   * hand. A game that has ended itself (`RoomGame.ended`, a crashed guest)
   * closes the room with its reason.
   */
  tick(): void {
    if (this.closed) return;
    const now = this.ports.now();
    const seats = this.seats.list;
    for (const seat of seats) {
      seat.neutralIfIdle(now);
      if (!seat.hasPending) continue;
      this.game.input(seat.id, seat.pendingSeq, seat.pending);
      seat.consumed();
    }
    this.game.tick(now);
    const ended = this.game.ended;
    if (ended !== null) {
      this.close(ended);
      return;
    }
    for (const seat of seats) this.send(seat, now);
    this.expireHeldSeats(now);
  }

  /**
   * Take a seat's view; send it when the seat is connected.
   *
   * @param seat The seat.
   * @param now The room's clock.
   */
  private send(seat: RoomPlayer, now: number): void {
    const view = this.game.viewFor(seat.id);
    const conn = seat.conn;
    if (conn === null) return;
    // The ack names input a simulation step has used, when the game can say so.
    const ack = this.game.ackFor?.(seat.id) ?? seat.lastAck;
    this.wire.cmd(conn, view.frame, ack, view.entity, view.commands);
    for (const message of view.messages) {
      if (!this.wire.msg(conn, message.name, message.payload)) {
        this.ports.log('room.msg-too-big', { player: seat.id, name: message.name });
      }
    }
    // A microsecond of slack: 3 x (1000 / 60) is not exactly 50 in floating point.
    if (now - seat.lastRowsAt >= this.rowsEveryMs - 1e-3) {
      seat.lastRowsAt = now;
      this.wire.rows(conn, view.frame, ack, view.takeRows());
    }
  }

  /** @param now The room's clock. */
  private expireHeldSeats(now: number): void {
    const seats = this.seats.list;
    for (let i = seats.length - 1; i >= 0; i -= 1) {
      const seat = seats[i];
      if (seat.conn !== null || now - seat.lastSeen < this.leaveAfterMs) continue;
      this.seats.remove(seat);
      this.ports.log('room.leave', { player: seat.id, reason: 'timeout' });
      this.game.leave(seat.id, 'timeout');
      this.door.announce();
    }
  }
}

/**
 * @param options The room's options.
 * @returns The seats: the game's own count when it has one, else the option.
 * @throws {TypeError} When neither says, or the two disagree.
 */
function seatCount(options: RoomOptions): number {
  const own = options.game.maxPlayers;
  const asked = options.maxPlayers;
  if (own !== undefined && asked !== undefined && own !== asked) {
    throw new TypeError(
      `createRoom: maxPlayers ${String(asked)} disagrees with the game's ${String(own)} seats; leave it out`,
    );
  }
  const seats = own ?? asked;
  if (seats === undefined)
    throw new TypeError('createRoom: maxPlayers is required when the game does not say its seats');
  return seats;
}

/**
 * Make a room. It starts ticking at once, on `ports.setTimer`.
 *
 * @param options Code, game, ports, seats and rates.
 * @returns The room.
 * @throws {TypeError} When the seats are unknown or contradict the game's.
 *
 * @example
 * ```ts
 * import { createRoom } from 'gameable/net/server';
 *
 * const room = createRoom({ code: 'KQTX', game, ports, maxPlayers: 8, sendHz: 20 });
 * ```
 */
export function createRoom(options: RoomOptions): Room {
  return new Room(options);
}
