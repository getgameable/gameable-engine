/**
 * `RoomInbound` — a room's two client channels, wired to the game.
 */
import type { RoomGame } from '@gameable/net/server';
import { type Client, CloseCode } from '@colyseus/core';

import type { GameableWire } from './GameableWire.js';
import { createRoomIntake, type RoomIntake } from './RoomIntake.js';
import type { Seat, SeatMap } from './SeatMap.js';

/**
 * What each `onMessageBytes` handler does with a frame. INPUT is coalesced
 * into the seat; a `msg` goes to `game.message`; a `ping` is answered with a
 * `pong`; a refused frame is counted and ignored. Every frame, refused or
 * not, stamps the seat's `lastFrameAt` (the idle drop reads it). A seat over its input
 * budget gets `error: budget` and is closed with 4002 at once, marked so its seat is
 * freed instead of held. Text is gentler (`TextLimit`): out of budget the player is
 * told `error: budget` once and its frames are dropped; only `closeAfter` refusals in a
 * row close it the same way, without telling it twice.
 *
 * @example
 * ```ts
 * import { createRoomInbound } from 'gameable/rooms/server';
 *
 * const inbound = createRoomInbound(game, seats, wire);
 * room.onMessageBytes(INPUT_TYPE, (client, bytes) => inbound.input(client, bytes));
 * ```
 */
export class RoomInbound {
  /** What came in and what was refused. */
  readonly intake: RoomIntake = createRoomIntake();

  /**
   * @param game The game.
   * @param seats The seats.
   * @param wire Builds the `pong` and `error` frames.
   */
  constructor(
    private readonly game: RoomGame,
    private readonly seats: SeatMap,
    private readonly wire: GameableWire,
  ) {}

  /**
   * @param client The sender.
   * @param bytes A frame sent as `INPUT_TYPE`.
   */
  input(client: Client, bytes: Uint8Array): void {
    const seat = this.seats.get(client.sessionId);
    if (seat === undefined) return;
    const now = performance.now();
    seat.lastFrameAt = now;
    if (this.intake.input(seat, bytes, now) === 'budget') this.drop(client, seat);
  }

  /**
   * @param client The sender.
   * @param bytes A frame sent as `TEXT_TYPE`.
   */
  text(client: Client, bytes: Uint8Array): void {
    const seat = this.seats.get(client.sessionId);
    if (seat === undefined) return;
    const now = performance.now();
    seat.lastFrameAt = now;
    const outcome = this.intake.text(seat, bytes, now);
    if (outcome.kind === 'msg') this.game.message(seat.player.id, outcome.name, outcome.payload);
    else if (outcome.kind === 'ping') client.raw(this.wire.pong(outcome.at, performance.now()));
    else if (outcome.kind === 'budget' && outcome.verdict === 'tell')
      client.raw(this.wire.error('budget'));
    else if (outcome.kind === 'budget' && outcome.verdict === 'close') this.drop(client, seat, false);
  }

  /**
   * @param client The client over budget.
   * @param seat Its seat.
   * @param tell Whether to send `error: budget` first (false when it was told already).
   */
  private drop(client: Client, seat: Seat, tell = true): void {
    if (seat.dropped !== null) return;
    seat.dropped = 'budget';
    if (tell) client.raw(this.wire.error('budget'));
    client.leave(CloseCode.WITH_ERROR);
  }
}

/**
 * A room's inbound side.
 *
 * @param game The game.
 * @param seats The seats.
 * @param wire Builds the `pong` and `error` frames.
 * @returns The inbound side.
 *
 * @example
 * ```ts
 * import { createAosWire, createRoomInbound, createSeatMap } from 'gameable/rooms/server';
 *
 * const inbound = createRoomInbound(game, createSeatMap(), createAosWire());
 * ```
 */
export function createRoomInbound(game: RoomGame, seats: SeatMap, wire: GameableWire): RoomInbound {
  return new RoomInbound(game, seats, wire);
}
