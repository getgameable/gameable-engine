/**
 * The page's one boot decision for a multiplayer game: the in-page authority
 * (Play Solo) or the room server.
 */
import type { RoomConnection } from '../client/RoomConnection.js';
import type { RoomMode } from './roomMode.js';

/** An engine's frame events, as Play Solo's `drive` hooks them (no engine import: this entry stays light). */
interface FrameEvents {
  readonly events: {
    on(event: 'engine:frame', fn: (frame: { substeps: number }) => void): () => void;
  };
}

/** The in-page authority, as far as the page needs it. */
export interface SoloLink {
  /** The connection the page's `multiplayer` feature joins. */
  readonly connection: RoomConnection;
  /** Step on the page engine's frames (`InPageAuthority.drive`); returns a function that stops it. */
  drive?(engine: FrameEvents): () => void;
}

/**
 * The page's side of `multiplayer`, for `clientFeatures({ multiplayer })`:
 * a solo connection, or which room to ask the room server for.
 *
 * @example
 * ```ts
 * import type { PageRoomOptions } from 'gameable/net/page';
 * const quick: PageRoomOptions = { game: 'my-game', name: 'Ana', newRoom: false };
 * ```
 */
export interface PageRoomOptions {
  /** Play Solo's loopback connection; with it nothing else is used. */
  readonly connection?: RoomConnection;
  /** The player's display name. */
  readonly name?: string;
  /** The game's catalog name (`catalogName`). */
  readonly game?: string;
  /** The room code to join. */
  readonly room?: string;
  /** Make a fresh room. */
  readonly newRoom?: boolean;
}

/** What {@link chooseRoom} needs from the page. */
export interface ChooseRoomOptions<S extends SoloLink> {
  /** The game's catalog name. */
  readonly game: string;
  /** The player's display name. */
  readonly name: string;
  /** Start the in-page authority. Called only for `solo`, so a room page never loads it. */
  readonly startSolo: () => Promise<S>;
}

/** The decision: the authority, if any, and the `multiplayer` overrides. */
export interface ChosenRoom<S extends SoloLink> {
  /** The mode it was made for. */
  readonly mode: RoomMode;
  /** The started in-page authority, or null for a room on the room server. */
  readonly solo: S | null;
  /** For `clientFeatures({ multiplayer })`. */
  readonly multiplayer: PageRoomOptions;
}

/**
 * Pick the room for a page: Play Solo starts the in-page authority and joins
 * it; any other mode leaves the authority unloaded and names the room for
 * `gameable/rooms/client`'s default connection.
 *
 * @param mode The page's `roomMode(location.search)`.
 * @param options The game's catalog name, the player's name, and how to start solo.
 * @returns The authority (or null) and the `multiplayer` overrides.
 *
 * @example
 * ```ts
 * import { chooseRoom, roomMode } from 'gameable/net/page';
 * import { clientFeatures } from 'gameable/host/features';
 *
 * declare function startSolo(): Promise<import('gameable/net/page').SoloLink>;
 * const room = await chooseRoom(roomMode(location.search), { game: 'my-game', name: 'You', startSolo });
 * const table = clientFeatures({ multiplayer: room.multiplayer });
 * ```
 */
export async function chooseRoom<S extends SoloLink>(
  mode: RoomMode,
  options: ChooseRoomOptions<S>,
): Promise<ChosenRoom<S>> {
  const { game, name } = options;
  switch (mode.kind) {
    case 'solo': {
      const solo = await options.startSolo();
      return { mode, solo, multiplayer: { connection: solo.connection, name } };
    }
    case 'join':
      return { mode, solo: null, multiplayer: { game, name, room: mode.code, newRoom: false } };
    case 'new':
      return { mode, solo: null, multiplayer: { game, name, newRoom: true } };
    case 'quick':
      return { mode, solo: null, multiplayer: { game, name, newRoom: false } };
  }
}
