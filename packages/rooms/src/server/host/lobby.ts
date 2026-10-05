/**
 * The room server's one lobby.
 */
import { LobbyRoom, ServerError } from '@colyseus/core';

import type { AddressLimits } from './AddressLimits.js';

/** The status a second lobby create gets: the lobby exists, join it. */
const LOBBY_EXISTS = 409;
const TOO_MANY = 429;
/** The join option the request gate writes with the client's limit key (`PEER_OPTION`). */
const PEER = 'aosPeer';

type LobbyClient = Parameters<LobbyRoom['onJoin']>[0];
type LobbyOptions = Parameters<LobbyRoom['onJoin']>[1];

/**
 * A `LobbyRoom` class capped at one live instance: one lobby lists every
 * room, so a second create (`create('lobby')`) is refused 409, and
 * `joinOrCreate('lobby')` joins the one there is. Without the cap, `lobby`
 * sat outside `maxRooms` and could be created without limit. With `limits`,
 * one address holds at most `lobbySocketsPerAddress` lobby sockets (429 past it).
 *
 * @param limits The server's address limits; none, no socket cap.
 * @returns The class to `define('lobby', ...)`, with its own count.
 *
 * @example
 * ```ts
 * import { createSingleLobby } from 'gameable/rooms/server';
 *
 * server.define('lobby', createSingleLobby());
 * ```
 */
export function createSingleLobby(limits?: AddressLimits): typeof LobbyRoom {
  let live = 0;
  return class SingleLobby extends LobbyRoom {
    private counted = false;
    private readonly keys = new Map<string, string>();

    override async onCreate(options: unknown): Promise<void> {
      if (live >= 1) throw new ServerError(LOBBY_EXISTS, 'the lobby already exists: join it');
      live += 1;
      this.counted = true;
      await super.onCreate(options);
    }

    override onJoin(client: LobbyClient, options: LobbyOptions): void {
      const key = (options as Record<string, unknown> | undefined)?.[PEER];
      if (limits !== undefined && typeof key === 'string') {
        if (!limits.joinLobby(key))
          throw new ServerError(TOO_MANY, 'this address holds the most lobby sockets it may');
        this.keys.set(client.sessionId, key);
      }
      super.onJoin(client, options);
    }

    override onLeave(client: LobbyClient): void {
      const key = this.keys.get(client.sessionId);
      if (key !== undefined) limits?.leaveLobby(key);
      this.keys.delete(client.sessionId);
      super.onLeave(client);
    }

    override onDispose(): void {
      if (this.counted) live -= 1;
      this.counted = false;
      for (const key of this.keys.values()) limits?.leaveLobby(key);
      this.keys.clear();
      super.onDispose();
    }
  };
}
