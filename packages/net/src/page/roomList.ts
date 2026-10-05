/**
 * The public room list as a page reads it: what one listed room says, and the
 * live list `gameable/rooms/client`'s `listRooms` keeps. Types only, so the
 * page module stays free of the room server client, which the browse panel
 * loads only when it opens.
 */

/**
 * One public room of a game, as the room server's lobby lists it. Every
 * field came from the server: show it as text, never as markup.
 *
 * @example
 * ```ts
 * import type { PublicRoom } from 'gameable/net/page';
 * const room: PublicRoom = { code: 'KQTX', players: 2, maxPlayers: 6, phase: 'lobby' };
 * ```
 */
export interface PublicRoom {
  /** The room code (`?room=CODE` joins it). */
  readonly code: string;
  /** Seats taken, held ones included. */
  readonly players: number;
  /** Seats in the room. */
  readonly maxPlayers: number;
  /** What the game says it is doing (`lobby`, `playing`), or null when it says nothing. */
  readonly phase: string | null;
}

/**
 * A game's public rooms, kept current by the room server's lobby until
 * `close()`.
 *
 * @example
 * ```ts
 * import type { LiveRoomList } from 'gameable/net/page';
 * declare const list: LiveRoomList;
 * const off = list.onChange(() => console.log(list.rooms.length));
 * off();
 * list.close();
 * ```
 */
export interface LiveRoomList {
  /** The rooms now, a fresh array after every change. */
  readonly rooms: readonly PublicRoom[];
  /** `open` while the lobby socket is up; `closed` after `close()` or a lost link. */
  readonly state: 'open' | 'closed';
  /**
   * @param fn Called after every change to `rooms` or `state`.
   * @returns A function that stops the calls.
   */
  onChange(fn: () => void): () => void;
  /** Leave the lobby. Twice is harmless. */
  close(): void;
}

/**
 * Opens a live list: `gameable/host/features`' `listPublicRooms`,
 * which loads the room server client only when it is called.
 *
 * @example
 * ```ts
 * import type { RoomListLoader } from 'gameable/net/page';
 * declare const load: RoomListLoader;
 * const list = await load('my-game', 'wss://play.example/services/rooms/');
 * ```
 */
export type RoomListLoader = (game: string, endpoint: string) => Promise<LiveRoomList>;
