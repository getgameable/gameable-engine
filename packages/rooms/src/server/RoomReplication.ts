/**
 * `RoomReplication` — a room's outbound side: each player's welcome, and
 * each tick's `cmd`, messages and rows.
 */
import type { RoomGame } from '@gameable/net/server';
import { type Client, ClientState, logger } from '@colyseus/core';

import type { ReplicationSource } from './GameableSerializer.js';
import { type GameableWire, createAosWire } from './GameableWire.js';
import type { Seat, SeatMap } from './SeatMap.js';

/** The room's clients by session: Colyseus's `ClientArray`. */
export interface ClientLookup {
  get(sessionId: string): Client | undefined;
}

/**
 * What each player is sent, and only that player. The welcome is built from
 * `game.snapshotFor(thatPlayer)` (which also resets that player's view), and
 * each tick every seat's own `viewFor` becomes its own `cmd` (with its ack
 * and its entity), messages and, every `1000 / sendHz` ms, rows. A held
 * seat's view is taken and thrown away, so nothing piles up. Only clients
 * Colyseus has fully joined are sent to.
 *
 * @example
 * ```ts
 * import { createRoomReplication } from 'gameable/rooms/server';
 *
 * const replication = createRoomReplication(game, seats, room.clients, 20);
 * room.setSerializer(createAosSerializer(replication));
 * ```
 */
export class RoomReplication implements ReplicationSource {
  /** The frames; the room builds its `pong` and `error` frames with it too. */
  readonly wire: GameableWire = createAosWire();
  /** The room clock of the current tick, ms. */
  now = 0;
  /** The room's code, named in every welcome; the room sets it once it has one. */
  room: string | null = null;
  private readonly rowsEveryMs: number;
  private readonly warned = new Set<string>();

  /**
   * @param game The game.
   * @param seats The seats.
   * @param clients The room's clients.
   * @param sendHz Rows frames per second to each player.
   */
  constructor(
    private readonly game: RoomGame,
    private readonly seats: SeatMap,
    private readonly clients: ClientLookup,
    sendHz: number,
  ) {
    this.rowsEveryMs = 1000 / sendHz;
  }

  /**
   * That player's welcome, on a first join and on every reconnect; the others
   * get the new `players` list.
   *
   * @param client A client that just acknowledged the join.
   * @returns The `ROOM_STATE` frame.
   */
  welcomeFor(client: Client): Uint8Array {
    const seat = this.seats.get(client.sessionId);
    if (seat === undefined) throw new Error('RoomReplication: a welcome for a client with no seat');
    const id = seat.player.id;
    seat.player.lastRowsAt = Number.NEGATIVE_INFINITY;
    const game = this.game;
    const snapshot = game.snapshotFor(id);
    const players = this.seats.summaries();
    const welcome = this.wire.welcome(id, game.entityOf?.(id) ?? 0, game.frame, snapshot, players, this.room);
    this.announce(seat);
    return welcome;
  }

  /** Send every joined player this tick's frames. */
  flush(): void {
    const game = this.game;
    for (const seat of this.seats.list()) {
      const player = seat.player;
      const view = game.viewFor(player.id); // taken for held seats too
      const client = this.joined(seat);
      if (client === undefined) continue;
      const ack = game.ackFor?.(player.id) ?? player.lastAck;
      client.raw(this.wire.cmd(view.frame, ack, view.entity, view.commands));
      for (const message of view.messages) {
        const frame = this.wire.msg(message.name, message.payload);
        if (frame !== null) client.raw(frame);
        else this.warnOnce(message.name);
      }
      // A microsecond of slack: 3 x (1000 / 60) is not exactly 50 in floating point.
      if (this.now - player.lastRowsAt >= this.rowsEveryMs - 1e-3) {
        player.lastRowsAt = this.now;
        const rows = this.wire.rows(view.frame, ack, view.takeRows());
        if (rows !== null) client.raw(rows);
      }
    }
  }

  /** @param except A seat that was just welcomed with the list. */
  announce(except?: Seat): void {
    this.sendAll(this.wire.players(this.seats.summaries()), except);
  }

  /**
   * @param frame A frame for every joined player (never mutated: one buffer is safe).
   * @param except A seat to leave out.
   */
  sendAll(frame: Uint8Array, except?: Seat): void {
    for (const seat of this.seats.list()) if (seat !== except) this.joined(seat)?.raw(frame);
  }

  private joined(seat: Seat): Client | undefined {
    const client = this.clients.get(seat.sessionId);
    return client !== undefined && client.state === ClientState.JOINED ? client : undefined;
  }

  /** @param name A message over the payload cap: warn once per name, not per tick. */
  private warnOnce(name: string): void {
    if (this.warned.has(name)) return;
    this.warned.add(name);
    logger.warn(`aos room: msg "${name}" is over the payload cap; dropped (warned once)`);
  }
}

/**
 * A room's outbound side.
 *
 * @param game The game.
 * @param seats The seats.
 * @param clients The room's clients (`room.clients`).
 * @param sendHz Rows frames per second to each player.
 * @returns The replication.
 *
 * @example
 * ```ts
 * import { createRoomReplication, createSeatMap } from 'gameable/rooms/server';
 *
 * const replication = createRoomReplication(game, createSeatMap(), new Map(), 20);
 * ```
 */
export function createRoomReplication(
  game: RoomGame,
  seats: SeatMap,
  clients: ClientLookup,
  sendHz: number,
): RoomReplication {
  return new RoomReplication(game, seats, clients, sendHz);
}
