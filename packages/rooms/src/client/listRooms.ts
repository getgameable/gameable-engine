/**
 * `listRooms` — a game's public rooms, live, from the room server's lobby.
 */
import { roomsEndpoint } from '@gameable/net/page';
import { Client } from '@colyseus/sdk';

import type { PageLocation } from './module.js';
import { RoomList } from './RoomList.js';

/** The room server's lobby room (`LOBBY_ROOM` on the server). */
const LOBBY = 'lobby';
/** How long {@link listRooms} waits for the lobby's first list by default, in ms. */
const FIRST_LIST_MS = 5000;

/**
 * Options for {@link listRooms}.
 *
 * @example
 * ```ts
 * import type { ListRoomsOptions } from 'gameable/rooms/client';
 * const options: ListRoomsOptions = { url: 'wss://play.example/services/rooms/' };
 * ```
 */
export interface ListRoomsOptions {
  /** The room server. Default `roomsEndpoint(location.href)`, as `multiplayer()` uses. */
  readonly url?: string;
  /** The page's address, for that default. Default `globalThis.location`. */
  readonly location?: PageLocation;
  /** HTTP and upgrade headers, for Node (a test's `origin`). */
  readonly headers?: Readonly<Record<string, string>>;
  /** Give up on the lobby's first list after this many ms. Default 5000. */
  readonly timeoutMs?: number;
}

/**
 * Join the room server's lobby and keep one game's public rooms: the code,
 * the seats taken and the game's phase of each, updated as players join and
 * leave. Private rooms are never listed (the server keeps them out), and
 * only rooms of `game` are kept. Each open list holds one lobby socket, and
 * an address may hold 4: `close()` the list when the panel closes.
 *
 * @param game The game's catalog name (`catalogName`).
 * @param options Where the room server is.
 * @returns The list, once the lobby's first list has arrived.
 * @throws {Error} When the lobby refuses (a bad origin, too many lobby
 *   sockets), the link closes first, or nothing arrives in `timeoutMs`.
 *
 * @example
 * ```ts
 * import { listRooms } from 'gameable/rooms/client';
 *
 * const list = await listRooms('party');
 * const off = list.onChange(() => console.log(list.rooms.map((r) => r.code)));
 * off();
 * list.close();
 * ```
 */
export async function listRooms(game: string, options: ListRoomsOptions = {}): Promise<RoomList> {
  const page = options.location ?? (globalThis as { location?: PageLocation }).location;
  const url = options.url ?? (page === undefined ? undefined : roomsEndpoint(page.href));
  if (url === undefined) throw new Error('listRooms: no room server; pass { url }');
  const headers = options.headers;
  const client = new Client(url, headers === undefined ? undefined : { headers: { ...headers } });
  const lobby = await client.joinOrCreate(LOBBY, { filter: { name: game } });
  const list = new RoomList(lobby, game);
  await new Promise<void>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined = undefined;
    const off = list.onChange(() => {
      clearTimeout(timer);
      off();
      if (list.state === 'open') resolve();
      else reject(new Error('listRooms: the lobby closed'));
    });
    timer = setTimeout(() => {
      off();
      list.close();
      reject(new Error('listRooms: the lobby sent no list'));
    }, options.timeoutMs ?? FIRST_LIST_MS);
  });
  return list;
}
