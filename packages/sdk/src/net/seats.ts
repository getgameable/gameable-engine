/**
 * How many seats a room game has: `features.multiplayer.maxPlayers`, read in
 * one place by the guest (its player slots) and by the room host (its door).
 */
import { MAX_PLAYER_ID } from './roles';
import type { GameDefinition } from '../defineGame';

/**
 * Seats in a room when the game declares `features.multiplayer` without a
 * `maxPlayers`.
 *
 * @example
 * ```ts
 * import { DEFAULT_ROOM_SEATS, defineGame, roomSeats } from 'gameable';
 *
 * const game = defineGame({ features: { multiplayer: true } });
 * roomSeats(game) === DEFAULT_ROOM_SEATS; // true
 * ```
 */
export const DEFAULT_ROOM_SEATS = 8;

/**
 * The seats a game declares: `features.multiplayer.maxPlayers`. Seats are ids
 * `0..seats - 1`. The guest makes exactly that many player slots and ignores
 * (with one warning) a join or input past them; a room built by
 * `createEngineRoomGame` refuses the next joiner with `full`. Both read this
 * function, so the two cannot disagree.
 *
 * @param definition The `defineGame` result.
 * @returns The seat count, {@link DEFAULT_ROOM_SEATS} for `multiplayer: true`,
 *   or undefined when the game does not declare `features.multiplayer`.
 * @throws {Error} When `maxPlayers` is not a whole number from 1 to 4097.
 *
 * @example
 * ```ts
 * import { defineGame, roomSeats } from 'gameable';
 *
 * const game = defineGame({ features: { multiplayer: { maxPlayers: 6 } } });
 * roomSeats(game); // 6: seats 0 to 5
 * ```
 */
export function roomSeats(definition: GameDefinition): number | undefined {
  const feature = definition.features?.multiplayer;
  if (feature === undefined || feature === false) return undefined;
  if (feature === true || feature.maxPlayers === undefined) return DEFAULT_ROOM_SEATS;
  const seats = feature.maxPlayers;
  if (!Number.isInteger(seats) || seats < 1 || seats > MAX_PLAYER_ID + 1) {
    throw new Error(
      `features.multiplayer.maxPlayers must be a whole number from 1 to ${String(MAX_PLAYER_ID + 1)}, ` +
        `got ${JSON.stringify(seats)}`,
    );
  }
  return seats;
}
