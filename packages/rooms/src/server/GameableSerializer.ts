/**
 * `GameableSerializer` — a Colyseus `Serializer` that carries our replication
 * instead of `@colyseus/schema`.
 */
import type { Client, Serializer } from '@colyseus/core';

import { SERIALIZER_ID } from '../channels.js';

/** What the serializer asks of its room. */
export interface ReplicationSource {
  /**
   * @param client A client that just acknowledged JOIN_ROOM: a first join or a reconnect.
   * @returns Its `ROOM_STATE` frame: that player's welcome.
   */
  welcomeFor(client: Client): Uint8Array;
  /** Send every client this tick's frames: its `cmd`, its messages, and rows when due. */
  flush(): void;
}

const EMPTY = new Uint8Array(0);

/**
 * Our replication behind Colyseus's serializer seam. Colyseus calls
 * `getFullState(client)` per client right after it acknowledges JOIN_ROOM,
 * on a first join and on every reconnect: exactly where our welcome belongs,
 * and per client, so each player gets their own snapshot.
 * `applyPatches` is called by `Room.broadcastPatch()`; the room sets
 * `patchRate = null` and calls `broadcastPatch()` itself once per 60 Hz
 * tick, so one "patch" is one tick of every player's own frames.
 *
 * @example
 * ```ts
 * import { createAosSerializer } from 'gameable/rooms/server';
 *
 * // inside a Colyseus Room's onCreate:
 * this.setSerializer(createAosSerializer(source));
 * ```
 */
export class GameableSerializer implements Serializer<object> {
  /** The id both sides register (`SERIALIZER_ID`). */
  id = SERIALIZER_ID;

  /** @param source The room: it knows the seats and the game. */
  constructor(private readonly source: ReplicationSource) {}

  /** Nothing to reset: the state is the game, not a schema. */
  reset(): void {}

  /**
   * @param client The client to welcome. Without one (Colyseus's inspector
   *   sizing the state) there is no per-room state to show: empty.
   * @returns The welcome frame.
   */
  getFullState(client?: Client): Uint8Array {
    return client === undefined ? EMPTY : this.source.welcomeFor(client);
  }

  /** @returns True: every tick sends. */
  applyPatches(): boolean {
    this.source.flush();
    return true;
  }
}

/**
 * A serializer for one room.
 *
 * @param source The room's welcome and flush.
 * @returns The serializer.
 *
 * @example
 * ```ts
 * import { createAosSerializer } from 'gameable/rooms/server';
 *
 * const serializer = createAosSerializer({ welcomeFor: () => new Uint8Array(1), flush: () => {} });
 * ```
 */
export function createAosSerializer(source: ReplicationSource): GameableSerializer {
  return new GameableSerializer(source);
}
