/**
 * `RoomList` — one game's public rooms, kept current by the room server's
 * lobby (Colyseus's `LobbyRoom`): its `rooms` message is the whole list, `+`
 * adds or updates one room, `-` removes one.
 */
import type { LiveRoomList, PublicRoom } from '@gameable/net/page';
import type { Room } from '@colyseus/sdk';

import { publicRoom } from './publicRoom.js';

/**
 * A live list over one lobby socket. Made by {@link listRooms}; `close()`
 * leaves the lobby, which frees one of the address's lobby sockets.
 *
 * @example
 * ```ts
 * import { listRooms } from 'gameable/rooms/client';
 *
 * const list = await listRooms('party');
 * list.onChange(() => console.log(list.rooms));
 * list.close();
 * ```
 */
export class RoomList implements LiveRoomList {
  private current: PublicRoom[] = [];
  private stateValue: 'open' | 'closed' = 'open';
  private readonly byId = new Map<string, PublicRoom>();
  private readonly listeners = new Set<() => void>();

  /**
   * @param lobby The joined lobby room.
   * @param game The game whose rooms are kept; entries of any other are dropped.
   */
  constructor(
    private readonly lobby: Room,
    private readonly game: string,
  ) {
    lobby.onMessage('rooms', (entries: unknown) => {
      this.byId.clear();
      for (const entry of Array.isArray(entries) ? entries : []) this.put(entry);
      this.changed();
    });
    lobby.onMessage('+', (pair: unknown) => {
      if (!Array.isArray(pair) || typeof pair[0] !== 'string') return;
      this.byId.delete(pair[0]);
      this.put(pair[1], pair[0]);
      this.changed();
    });
    lobby.onMessage('-', (roomId: unknown) => {
      if (typeof roomId === 'string' && this.byId.delete(roomId)) this.changed();
    });
    lobby.onLeave(() => {
      this.stateValue = 'closed';
      this.changed();
    });
  }

  get rooms(): readonly PublicRoom[] {
    return this.current;
  }

  get state(): 'open' | 'closed' {
    return this.stateValue;
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  close(): void {
    if (this.stateValue === 'closed') return;
    this.stateValue = 'closed';
    void this.lobby.leave(true).catch(() => undefined);
    this.changed();
    this.listeners.clear();
  }

  /**
   * @param entry A lobby entry.
   * @param roomId Its room id, when the message names it apart from the entry.
   */
  private put(entry: unknown, roomId?: string): void {
    const room = publicRoom(entry, this.game);
    const id = roomId ?? (entry as { roomId?: unknown } | null)?.roomId;
    if (room !== null && typeof id === 'string') this.byId.set(id, room);
  }

  private changed(): void {
    this.current = [...this.byId.values()];
    for (const fn of [...this.listeners]) fn();
  }
}
