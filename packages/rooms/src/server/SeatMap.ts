/**
 * `SeatMap` — a room's seats, keyed by Colyseus `sessionId`.
 */
import type { PlayerSummary } from '@gameable/net';
import {
  Budget,
  type BudgetOptions,
  type PlayerIdentity,
  type RoomPlayer,
  SeatTable,
  type TextLimit,
  type TextLimitOptions,
} from '@gameable/net/server';

/** One seat: our `RoomPlayer` (id, name, coalesced input, acks) plus its budgets. */
export interface Seat {
  /** The Colyseus session holding the seat; kept across `allowReconnection`. */
  readonly sessionId: string;
  /** The player: `player.id` is the seat id, `player.connected` false while held. */
  readonly player: RoomPlayer;
  /** Text frames (`msg`, `ping`): the player's own `RoomPlayer.text`, budget and counts. */
  readonly text: TextLimit;
  /** INPUT frames. */
  readonly input: Budget;
  /** Who sits here (Task 5.3): the store key for Task 5.2. Null without `Identities`. */
  readonly identity: PlayerIdentity | null;
  /** Set when the room drops the seat for abuse: no hold, the seat goes at once. */
  dropped: string | null;
  /** When the client last sent a frame, or took or resumed the seat (`performance.now()`, ms). */
  lastFrameAt: number;
}

/** The budgets every seat gets. */
export interface SeatBudgets {
  /**
   * Text frames. Default 40, +20 per 5 s (Tala's numbers); out of it the
   * player is told `error: budget` once, and `closeAfter` (100) refusals in a
   * row close the client with 4002.
   */
  text?: TextLimitOptions;
  /**
   * INPUT frames. Default 120, +120 per second: twice the 60 Hz a client
   * sends at, so a burst after a stall passes and a flood does not.
   */
  input?: BudgetOptions;
}

const INPUT_BUDGET: BudgetOptions = { burst: 120, refill: 120, everyMs: 1000 };

/**
 * The seats of one room. Ids are 0 upward, the lowest free one first, so the
 * first joiner is player 0 (`RoomGame`'s rule); `list` stays ascending.
 * Colyseus keeps the `sessionId` across `allowReconnection`, so the seat
 * found by it after a reconnect is the same seat, id and entity.
 *
 * @example
 * ```ts
 * import { createSeatMap } from 'gameable/rooms/server';
 *
 * const seats = createSeatMap();
 * const ana = seats.add('session-a', 'Ana', 0); // ana.player.id === 0
 * seats.hold('session-a', 100); // dropped: held, still counts
 * seats.resume('session-a', 900); // back: the same seat
 * ```
 */
export class SeatMap {
  private readonly table: SeatTable;
  private readonly bySession = new Map<string, Seat>();
  private readonly ordered: Seat[] = [];

  /** @param budgets The budgets each new seat gets. */
  constructor(private readonly budgets: SeatBudgets = {}) {
    this.table = new SeatTable(budgets.text);
  }

  /** @returns How many seats are taken, held ones included. */
  get size(): number {
    return this.ordered.length;
  }

  /** @returns Every seat, ascending by id; the same array until a seat is added or removed. */
  list(): readonly Seat[] {
    return this.ordered;
  }

  /**
   * @param sessionId A Colyseus session.
   * @returns Its seat, held or not.
   */
  get(sessionId: string): Seat | undefined {
    return this.bySession.get(sessionId);
  }

  /**
   * Take a new seat at the lowest free id.
   *
   * @param sessionId The Colyseus session.
   * @param name The player's name.
   * @param now The room's clock, ms.
   * @param identity Who the player is, when the room resolved it.
   * @returns The seat.
   */
  add(sessionId: string, name: string, now: number, identity: PlayerIdentity | null = null): Seat {
    // No seat secret: Colyseus's reconnection token is the secret.
    const player = this.table.add('', name, sessionId, now);
    const seat: Seat = {
      sessionId,
      player,
      identity,
      text: player.text,
      input: new Budget(this.budgets.input ?? INPUT_BUDGET),
      dropped: null,
      lastFrameAt: performance.now(), // not the room clock, which is 0 before the first tick
    };
    this.bySession.set(sessionId, seat);
    this.ordered.splice(this.table.list.indexOf(player), 0, seat);
    return seat;
  }

  /**
   * The connection dropped: the seat is held. Every held key and button is
   * let go as pending input: each gets its `released` edge (edges that came
   * in since the last tick are kept), nothing is down, the modifiers are
   * off and the player is unfocused. The next tick hands that to the game.
   *
   * @param sessionId The Colyseus session.
   * @param now The room's clock, ms.
   * @returns The seat, if any.
   */
  hold(sessionId: string, now: number): Seat | undefined {
    const seat = this.bySession.get(sessionId);
    if (seat === undefined) return undefined;
    this.table.detach(sessionId, now);
    seat.player.release();
    return seat;
  }

  /**
   * The session is back (`allowReconnection` resolved).
   *
   * @param sessionId The Colyseus session.
   * @param now The room's clock, ms.
   * @returns The seat, if it is still held.
   */
  resume(sessionId: string, now: number): Seat | undefined {
    const seat = this.bySession.get(sessionId);
    if (seat === undefined) return undefined;
    this.table.attach(seat.player, sessionId, now);
    seat.player.lastRowsAt = Number.NEGATIVE_INFINITY;
    seat.lastFrameAt = performance.now();
    return seat;
  }

  /**
   * Free a seat.
   *
   * @param sessionId The Colyseus session.
   * @returns The seat it held, now gone.
   */
  remove(sessionId: string): Seat | undefined {
    const seat = this.bySession.get(sessionId);
    if (seat === undefined) return undefined;
    this.bySession.delete(sessionId);
    this.table.remove(seat.player);
    this.ordered.splice(this.ordered.indexOf(seat), 1);
    return seat;
  }

  /** @returns Every seat as the `players` frame lists them. */
  summaries(): PlayerSummary[] {
    return this.table.summaries();
  }
}

/**
 * A new seat map.
 *
 * @param budgets The budgets each seat gets; defaults 40 (+20 per 5 s) for
 *   text and 120 (+120 per s) for input.
 * @returns The map.
 *
 * @example
 * ```ts
 * import { createSeatMap } from 'gameable/rooms/server';
 *
 * const seats = createSeatMap({ text: { burst: 10 } });
 * ```
 */
export function createSeatMap(budgets?: SeatBudgets): SeatMap {
  return new SeatMap(budgets);
}
