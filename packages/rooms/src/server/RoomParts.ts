/**
 * What one `GameableColyseusRoom` is built from: its game and the parts around it.
 */
import type { RoomGame } from '@gameable/net/server';

import type { GameableRoomEntry } from './GameableRoomEntry.js';
import { createRoomInbound, type RoomInbound } from './RoomInbound.js';
import { type ClientLookup, createRoomReplication, type RoomReplication } from './RoomReplication.js';
import { createRoomSeating, type RoomSeating } from './RoomSeating.js';
import { createSeatMap, type SeatMap } from './SeatMap.js';

/**
 * A room's game and parts: seats, replication (out), seating (lifecycle) and
 * inbound (the two client channels).
 *
 * @example
 * ```ts
 * import { buildRoomParts } from 'gameable/rooms/server';
 *
 * const { game, seats } = await buildRoomParts(entry, room.clients);
 * ```
 */
export interface RoomParts {
  readonly game: RoomGame;
  readonly seats: SeatMap;
  readonly replication: RoomReplication;
  readonly seating: RoomSeating;
  readonly inbound: RoomInbound;
}

/**
 * One tick of the game: the seats' coalesced input, then `game.tick`. A seat
 * with no input frame for 250 ms has its held input let go once.
 *
 * @param parts The room's parts.
 * @param nowMs The room clock.
 * @returns `game.ended`: null while the game runs, else why it ended.
 *
 * @example
 * ```ts
 * import { advanceRoom } from 'gameable/rooms/server';
 *
 * if (advanceRoom(parts, nowMs) === null) room.broadcastPatch();
 * ```
 */
export function advanceRoom(parts: RoomParts, nowMs: number): string | null {
  const { game, replication } = parts;
  replication.now = nowMs;
  for (const seat of parts.seats.list()) {
    const player = seat.player;
    player.neutralIfIdle(nowMs); // no frame for 250 ms: let go of what it held, once
    if (!player.hasPending) continue;
    game.input(player.id, player.pendingSeq, player.pending);
    player.consumed();
  }
  game.tick(nowMs);
  return game.ended;
}

/**
 * @param entry The game to build.
 * @param clients The room's clients, by session id.
 * @returns The game, made by `entry.create()`, and its parts.
 * @throws {Error} When the game knows its own seats (`RoomGame.maxPlayers`)
 *   and they are not `entry.maxPlayers`: Colyseus would seat more or fewer
 *   players than the guest has slots for.
 *
 * @example
 * ```ts
 * import { buildRoomParts } from 'gameable/rooms/server';
 *
 * const parts = await buildRoomParts(entry, room.clients);
 * ```
 */
export async function buildRoomParts(entry: GameableRoomEntry, clients: ClientLookup): Promise<RoomParts> {
  const game = await entry.create();
  const own = game.maxPlayers;
  if (own !== undefined && own !== entry.maxPlayers) {
    game.dispose();
    throw new Error(
      `GameableColyseusRoom: the game has ${String(own)} seats but the room seats ${String(entry.maxPlayers)}; ` +
        "build it with the catalog's maxPlayers",
    );
  }
  const seats = createSeatMap(entry.budgets);
  const replication = createRoomReplication(game, seats, clients, entry.sendHz ?? 20);
  const seating = createRoomSeating(game, seats, replication);
  const inbound = createRoomInbound(game, seats, replication.wire);
  return { game, seats, replication, seating, inbound };
}
