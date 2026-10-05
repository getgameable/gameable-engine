/**
 * `engineGame` — a real game, run by `createEngineRoomGame`, as a catalog game.
 */
import { createEngineRoomGame, type EngineRoomGameOptions, type WasmGuest } from '@gameable/net/server';
import { DEFAULT_ROOM_SEATS, type GameDefinition, roomSeats, roomSendHz } from '@gameable/sdk';

import type { SeatBudgets } from '../SeatMap.js';
import type { CatalogGame } from './RoomCatalog.js';

/**
 * What `engineGame` takes: the game's definition (always: its seats are read
 * from it), the wasm guest when the game runs as wasm, and the engine options.
 *
 * @example
 * ```ts
 * import type { EngineGameOptions } from 'gameable/rooms/server';
 *
 * const options: EngineGameOptions = { definition: game, manifest: './assets.json', seed: 7 };
 * ```
 */
export interface EngineGameOptions
  extends Omit<EngineRoomGameOptions, 'definition' | 'guest' | 'maxPlayers' | 'seed'> {
  /**
   * The game's `defineGame` result: its `features.multiplayer` sets the seats
   * and the send rate. For a wasm game only its `features` are read, so a
   * host that has just the built game's `game.json` passes `{ features }`.
   */
  readonly definition: GameDefinition;
  /**
   * The run seed: one number for every room, or a function called once per
   * room (`gameable serve` rolls a fresh one, so two rooms deal differently).
   */
  readonly seed?: number | (() => number);
  /**
   * The game built to wasm: each room gets its own sandbox. Production rooms
   * use it. Without it the definition runs in direct mode, in this JS realm,
   * which `createRoomServer` allows only with `maxRooms: 1`.
   */
  readonly guest?: WasmGuest;
  /** Rows frames per second to each player. Default: the game's `features.multiplayer.sendHz`, else 20. */
  readonly sendHz?: number;
  /** Seconds a dropped seat is held. Default: the server's `leaveAfterMs`. */
  readonly reconnectSeconds?: number;
  /** Each seat's text and input budgets. */
  readonly budgets?: SeatBudgets;
}

/**
 * A game for the room catalog, built on `createEngineRoomGame`. Its seats are
 * `roomSeats(definition)` (sdk; `DEFAULT_ROOM_SEATS` for a game that declares
 * none), the same function the guest reads, and the catalog passes them on
 * explicitly, which a wasm guest requires. Its send rate is `roomSendHz(definition)`.
 *
 * @param options The definition, the guest for wasm, engine and room options.
 * @returns The catalog game.
 * @throws {Error} When the definition's `features.multiplayer.maxPlayers` is bad.
 * @throws {RangeError} When its `features.multiplayer.sendHz` is not from 1 to 60.
 *
 * @example
 * ```ts
 * import { createRoomServer, engineGame } from 'gameable/rooms/server';
 * import game from './game.js';
 * import { guest } from './guest.js'; // the game built to wasm: { guestModuleUrl, getCoreModule }
 *
 * const server = createRoomServer({
 *   port: 8790,
 *   origins: ['https://play.example'],
 *   games: { party: engineGame({ definition: game, guest, manifest: './assets.json', seed: 7 }) },
 * });
 * ```
 */
export function engineGame(options: EngineGameOptions): CatalogGame {
  const { definition, guest, sendHz, reconnectSeconds, budgets, seed, ...engine } = options;
  return {
    maxPlayers: roomSeats(definition) ?? DEFAULT_ROOM_SEATS,
    direct: guest === undefined,
    sendHz: sendHz ?? roomSendHz(definition),
    reconnectSeconds,
    budgets,
    create: ({ maxPlayers }) => {
      const roll = typeof seed === 'function' ? seed() : seed;
      const room = roll === undefined ? engine : { ...engine, seed: roll };
      return createEngineRoomGame(
        guest === undefined ? { ...room, definition, maxPlayers } : { ...room, guest, maxPlayers },
      );
    },
  };
}
