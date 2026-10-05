/**
 * `RoomSeating` — a room's seat lifecycle: join, drop, reconnect, leave.
 */
import type { PlayerIdentity, RoomGame } from '@gameable/net/server';
import { CloseCode } from '@colyseus/core';

import { displayName } from './RoomAdmission.js';
import type { RoomReplication } from './RoomReplication.js';
import type { SeatMap } from './SeatMap.js';

/**
 * What happens to a seat between Colyseus's hooks and the game.
 *
 * - `join`: the lowest free seat, then `game.join`.
 * - `drop`: the seat is held and the others told, unless the client was
 *   dropped for abuse: our budget, or Colyseus closing it with 4002
 *   (`WITH_ERROR`: its message rate cap, an unknown message type). An abuser's
 *   seat is not held; `leave` frees it at once. Colyseus's other 4002, a live
 *   client kicked because its token was presented again, never happens:
 *   `GameableColyseusRoom.checkReconnectionToken` refuses such a token instead.
 * - `drop` and `resume` also tell the game (`RoomGame.hold`, `resume`).
 * - `resume`: the held seat is the client's again.
 * - `leave`: the seat goes and `game.leave` hears why: the abuse reason,
 *   `left` for a consented leave, `timeout` for a hold that expired.
 *
 * @example
 * ```ts
 * import { createRoomSeating } from 'gameable/rooms/server';
 *
 * const seating = createRoomSeating(game, seats, replication);
 * seating.join('session-a', 'Ana');
 * ```
 */
export class RoomSeating {
  /**
   * @param game The game.
   * @param seats The seats.
   * @param replication Tells the others who is seated, and keeps the clock.
   */
  constructor(
    private readonly game: RoomGame,
    private readonly seats: SeatMap,
    private readonly replication: RoomReplication,
  ) {}

  /**
   * @param sessionId The Colyseus session.
   * @param name The seat's name (`seatName`: the portal's for a signed-in player), or the raw join option.
   * @param identity Who the player is, when the room resolved it.
   */
  join(sessionId: string, name: unknown, identity: PlayerIdentity | null = null): void {
    const display = displayName(name);
    const seat = this.seats.add(sessionId, display, this.replication.now, identity);
    this.game.join(seat.player.id, display, null, identity ?? undefined);
    // The welcome goes out from GameableSerializer.getFullState once the client acks the join.
  }

  /**
   * @param sessionId The Colyseus session.
   * @param code The close code.
   * @returns True when the seat is held: the room then calls `allowReconnection`.
   */
  drop(sessionId: string, code: number | undefined): boolean {
    const seat = this.seats.get(sessionId);
    if (seat === undefined) return false;
    if (code === CloseCode.WITH_ERROR) seat.dropped ??= 'flood';
    if (seat.dropped !== null) return false; // Colyseus calls onLeave next
    this.seats.hold(sessionId, this.replication.now);
    this.game.hold?.(seat.player.id); // held is gone, for the host role (ctx.players.host)
    this.replication.announce();
    return true;
  }

  /** @param sessionId The Colyseus session; the fresh welcome follows the join ack. */
  resume(sessionId: string): void {
    this.seats.resume(sessionId, this.replication.now);
    const seat = this.seats.get(sessionId);
    if (seat !== undefined) this.game.resume?.(seat.player.id);
  }

  /**
   * @param sessionId The Colyseus session.
   * @param code The close code.
   */
  leave(sessionId: string, code: number | undefined): void {
    const seat = this.seats.remove(sessionId);
    if (seat === undefined) return;
    const reason = seat.dropped ?? (code === CloseCode.CONSENTED ? 'left' : 'timeout');
    this.game.leave(seat.player.id, reason);
    this.replication.announce();
  }
}

/**
 * A room's seat lifecycle.
 *
 * @param game The game.
 * @param seats The seats.
 * @param replication The room's outbound side.
 * @returns The seating.
 *
 * @example
 * ```ts
 * import { createRoomSeating } from 'gameable/rooms/server';
 *
 * const seating = createRoomSeating(game, seats, replication);
 * ```
 */
export function createRoomSeating(
  game: RoomGame,
  seats: SeatMap,
  replication: RoomReplication,
): RoomSeating {
  return new RoomSeating(game, seats, replication);
}
