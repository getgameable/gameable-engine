/**
 * What a room is made from: one hostable game.
 */
import type { Identities, RoomGame } from '@gameable/net/server';

import type { AddressLimits } from './host/AddressLimits.js';
import type { RoomRegistry } from './host/RoomRegistry.js';
import type { SeatBudgets } from './SeatMap.js';

/**
 * One hostable game: how to build its `RoomGame`, and the numbers the room needs.
 *
 * @example
 * ```ts
 * import type { GameableRoomEntry } from 'gameable/rooms/server';
 *
 * const entry: GameableRoomEntry = { maxPlayers: 2, sendHz: 20, create: () => createEngineRoomGame(options) };
 * ```
 */
export interface GameableRoomEntry {
  /** Seats per room: Colyseus's `maxClients`. Held seats count. */
  readonly maxPlayers: number;
  /** Rows frames per second to each player. Default 20. */
  readonly sendHz?: number;
  /** Seconds a dropped seat is held for `allowReconnection`. Default 30. */
  readonly reconnectSeconds?: number;
  /**
   * Seconds a connected client may send no frame (INPUT or text) before the
   * room drops it with `IDLE_CLOSE_CODE`; its seat is then held for
   * `reconnectSeconds` as after any drop. Default 120.
   */
  readonly idleSeconds?: number;
  /** Each seat's text and input budgets; see `SeatBudgets`. */
  readonly budgets?: SeatBudgets;
  /** @returns A fresh game for a new room (for example `createEngineRoomGame(...)`). */
  create(): Promise<RoomGame> | RoomGame;
}

/**
 * What `define(name, GameableColyseusRoom, options)` passes. Colyseus merges the
 * define options over the client's join options, so a client cannot name
 * its own entry.
 *
 * @example
 * ```ts
 * import type { GameableRoomOptions } from 'gameable/rooms/server';
 *
 * const options: GameableRoomOptions = { entry };
 * ```
 */
export interface GameableRoomOptions {
  /** The game this room runs. */
  entry: GameableRoomEntry;
  /**
   * The room server's live rooms (`createRoomServer` passes it). With it the
   * room takes a slot under `maxRooms` and a four-letter code, which is also
   * its room id. Without it (a bare `Server`) the room has neither.
   */
  registry?: RoomRegistry;
  /**
   * The server's per-address limits (`createRoomServer` passes them). With
   * them each seat is charged to the address that joined it, at most
   * `seatsPerAddress` across every room. Without them seats are not counted.
   */
  limits?: AddressLimits;
  /**
   * Who joins (Task 5.3): the portal, then the device token
   * (`createRoomServer` passes `identitiesFromEnv(process.env)` by default).
   * Without it no identity is resolved and every seat keeps its typed name.
   */
  identities?: Identities;
}

/**
 * The create options a client may send, read in `onCreate`. Colyseus's own
 * `create` / `joinOrCreate` carry them.
 *
 * - `private: true` keeps the room out of the lobby and out of quick matching
 *   (`joinOrCreate` with no code); its code (the room id) still joins it.
 * - `code` on a create is refused: codes are the server's to give. A
 *   `joinOrCreate` naming a code no live room has ends here, as a failed join.
 *
 * @example
 * ```ts
 * import type { GameableCreateOptions } from 'gameable/rooms/server';
 *
 * const options: GameableCreateOptions = { name: 'Ana', private: true };
 * ```
 */
export interface GameableCreateOptions {
  /** The creator's display name. */
  name?: unknown;
  /** Unlisted and out of quick matching. */
  private?: unknown;
  /** A code: only ever a failed join by code when it reaches a create. */
  code?: unknown;
}
