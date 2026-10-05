/**
 * `RoomCatalog` — the games a room server hosts, each registered once.
 */
import type { RoomGame } from '@gameable/net/server';

import type { GameableRoomEntry } from '../GameableRoomEntry.js';
import type { SeatBudgets } from '../SeatMap.js';

/** The room name the server keeps for Colyseus's `LobbyRoom`. */
export const LOBBY_ROOM = 'lobby';
const NAME = /^[a-zA-Z0-9_-]+$/;

/**
 * What the catalog hands a game when a room needs one. `maxPlayers` is the
 * room's seat count: pass it on, for example to `createEngineRoomGame`, so the
 * guest's `net.maxPlayers` and Colyseus's `maxClients` are one number.
 *
 * @example
 * ```ts
 * import type { GameSetup } from 'gameable/rooms/server';
 *
 * const setup: GameSetup = { maxPlayers: 4 };
 * ```
 */
export interface GameSetup {
  readonly maxPlayers: number;
}

/**
 * One hostable game, as registered: the seat count and how to build a room's game.
 *
 * @example
 * ```ts
 * import { createEngineRoomGame } from 'gameable/net/server';
 * import type { CatalogGame } from 'gameable/rooms/server';
 *
 * const party: CatalogGame = {
 *   maxPlayers: 8,
 *   create: ({ maxPlayers }) => createEngineRoomGame({ definition, manifest, maxPlayers, seed: 7 }),
 * };
 * ```
 */
export interface CatalogGame {
  /** Seats per room, a whole number from 1. The only place this number is set. */
  readonly maxPlayers: number;
  /** Rows frames per second to each player. Default 20. */
  readonly sendHz?: number;
  /** Seconds a dropped seat is held. Default: the server's `leaveAfterMs`. */
  readonly reconnectSeconds?: number;
  /** Each seat's text and input budgets. */
  readonly budgets?: SeatBudgets;
  /**
   * True when the game runs in this JS realm (a `defineGame` result in direct
   * mode, not a wasm guest). Two direct rooms in one process share the SDK's
   * component arrays and corrupt each other, so `createRoomServer` accepts a
   * direct game only with `maxRooms: 1` (`gameable serve --direct`).
   */
  readonly direct?: boolean;
  /**
   * @param setup The room's seat count, always given.
   * @returns A fresh game for a new room.
   */
  create(setup: GameSetup): Promise<RoomGame> | RoomGame;
}

/** Defaults the catalog fills in for a game that leaves them out. */
export interface CatalogDefaults {
  /** Seconds a dropped seat is held. Default 30. */
  readonly reconnectSeconds?: number;
}

/**
 * The games a room server hosts, by room name. Each is registered once, and
 * the catalog is the one place that turns a game's `maxPlayers` into both the
 * room's seat count (`entry.maxPlayers`, Colyseus's `maxClients`) and the
 * `GameSetup` its `create` receives.
 *
 * @example
 * ```ts
 * import { createRoomCatalog } from 'gameable/rooms/server';
 *
 * const catalog = createRoomCatalog({ party });
 * catalog.entry('party').maxPlayers; // 8
 * ```
 */
export class RoomCatalog {
  private readonly entries = new Map<string, GameableRoomEntry>();
  /** Whether each game set its own hold, so a server's `leaveAfterMs` gives way to it. */
  private readonly ownHold = new Set<string>();
  private readonly direct: string[] = [];

  /** @param defaults What a game that leaves a number out gets. */
  constructor(private readonly defaults: CatalogDefaults = {}) {}

  /**
   * @param name The room name clients join (`[a-zA-Z0-9_-]+`, not `lobby`).
   * @param game The game.
   * @returns Its room entry.
   * @throws {Error} On a bad or reserved name, a second registration, or a bad `maxPlayers`.
   */
  register(name: string, game: CatalogGame): GameableRoomEntry {
    if (!NAME.test(name)) throw new Error(`RoomCatalog: "${name}" is not a room name`);
    if (name === LOBBY_ROOM) throw new Error(`RoomCatalog: "${LOBBY_ROOM}" is reserved`);
    if (this.entries.has(name)) throw new Error(`RoomCatalog: "${name}" is already registered`);
    const { maxPlayers } = game;
    if (!Number.isInteger(maxPlayers) || maxPlayers < 1)
      throw new Error(`RoomCatalog: "${name}" needs a whole maxPlayers from 1, not ${String(maxPlayers)}`);
    const setup: GameSetup = { maxPlayers };
    const entry: GameableRoomEntry = {
      maxPlayers,
      sendHz: game.sendHz,
      reconnectSeconds: game.reconnectSeconds ?? this.defaults.reconnectSeconds ?? 30,
      budgets: game.budgets,
      create: () => game.create(setup),
    };
    this.entries.set(name, entry);
    if (game.reconnectSeconds !== undefined) this.ownHold.add(name);
    if (game.direct === true) this.direct.push(name);
    return entry;
  }

  /**
   * @param name A registered room name.
   * @param defaults Defaults that win over the catalog's own (a server's
   *   `leaveAfterMs`), but never over a number the game set itself.
   * @returns Its entry.
   * @throws {Error} When no game has that name.
   */
  entry(name: string, defaults?: CatalogDefaults): GameableRoomEntry {
    const entry = this.entries.get(name);
    if (entry === undefined) throw new Error(`RoomCatalog: no game "${name}"`);
    const hold = defaults?.reconnectSeconds;
    if (hold === undefined || this.ownHold.has(name)) return entry;
    return { ...entry, reconnectSeconds: hold };
  }

  /** @returns The names of games that run in this JS realm (`CatalogGame.direct`). */
  directNames(): string[] {
    return [...this.direct];
  }

  /** @returns The registered room names, in registration order. */
  names(): string[] {
    return [...this.entries.keys()];
  }
}

/**
 * @param games Games to register now, by room name.
 * @param defaults What a game that leaves a number out gets.
 * @returns The catalog.
 *
 * @example
 * ```ts
 * import { createRoomCatalog } from 'gameable/rooms/server';
 *
 * const catalog = createRoomCatalog({ party }, { reconnectSeconds: 30 });
 * ```
 */
export function createRoomCatalog(
  games: Readonly<Record<string, CatalogGame>> = {},
  defaults?: CatalogDefaults,
): RoomCatalog {
  const catalog = new RoomCatalog(defaults);
  for (const [name, game] of Object.entries(games)) catalog.register(name, game);
  return catalog;
}
