/**
 * `gameable/net/server` — the authority's side: rooms, input intake,
 * replication and the player store. It opens no sockets: the room server
 * (`gameable/rooms/server`, on Colyseus) and Play Solo's in-page loopback
 * carry the frames. `pg` loads only when a Postgres store is first used.
 *
 * @example
 * ```ts
 * import { createRoom } from 'gameable/net/server';
 *
 * const room = createRoom({ code: 'KQTX', game, ports, maxPlayers: 8, sendHz: 20 });
 * ```
 */
export * from './identity/index.js';
export * from './inbound/index.js';
export * from './room/index.js';
export * from './store/index.js';
