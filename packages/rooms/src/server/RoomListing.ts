/**
 * `RoomListing` — a room's place on the server: its slot, its code and the
 * metadata the matchmaker and the lobby read.
 */
import { ServerError } from '@colyseus/core';

import type { GameableCreateOptions, GameableRoomOptions } from './GameableRoomEntry.js';
import type { HostedRoom, RoomRegistry } from './host/RoomRegistry.js';

/** What the listing needs from its room. */
export interface ListedRoom extends HostedRoom {
  roomId: string;
  readonly roomName: string;
  readonly maxClients: number;
  setMetadata(metadata: Record<string, unknown>): Promise<unknown>;
}

/** The HTTP status and SDK error code of a create that named a code no live room has. */
const NO_SUCH_CODE = 404;
/** The longest phase listed; a longer one is left out of the metadata. */
const MAX_PHASE = 32;

/**
 * A room's slot and code. With a registry (`createRoomServer`) the room takes
 * a slot under `maxRooms` and a code, which becomes its room id; without one
 * (a bare `Server`) it has neither and only publishes its metadata.
 *
 * @example
 * ```ts
 * import { RoomListing } from 'gameable/rooms/server';
 *
 * const listing = new RoomListing(room);
 * listing.claim(options); // in onCreate, before the game is built
 * await listing.publish();
 * listing.release(); // in onDispose
 * ```
 */
export class RoomListing {
  private registry: RoomRegistry | null = null;
  private code: string | null = null;
  private phase: string | null = null;

  /** @param room The room. */
  constructor(private readonly room: ListedRoom) {}

  /**
   * Take a slot and a code.
   *
   * @param options The define options (the registry) and the client's create options.
   * @throws {ServerError} 404 when the create names a code (a failed join by
   *   code), or the registry's capacity or rate error.
   */
  claim(options: GameableRoomOptions & GameableCreateOptions): void {
    const registry = options.registry;
    if (registry === undefined) return;
    if (options.code !== undefined)
      throw new ServerError(NO_SUCH_CODE, `no room has the code ${JSON.stringify(options.code).slice(0, 10)}`);
    this.code = registry.open(this.room); // over maxRooms this throws, before any game is built
    this.registry = registry;
    this.room.roomId = this.code;
  }

  /**
   * Give the slot and the code back. Twice is harmless.
   *
   * @param failure Why the build failed, if it did (a broken physics marks the server not ok).
   */
  release(failure?: unknown): void {
    this.registry?.close(this.room, failure);
    this.registry = null;
  }

  /**
   * Re-list the room when its game's phase changed (`RoomGame.phase`). Every
   * tick; nothing is allocated or sent while the phase is the same.
   *
   * @param phase The game's phase now.
   */
  follow(phase: string | null): void {
    if (phase === this.phase) return;
    this.phase = phase;
    void this.publish();
  }

  /**
   * @returns When the metadata is set: `{ game, code?, players, maxPlayers, phase? }`.
   *   `setMetadata` replaces it all, filterBy's `code` included, so the code
   *   is re-set every time.
   */
  publish(): Promise<void> {
    const metadata: Record<string, unknown> = { game: this.room.roomName };
    if (this.code !== null) metadata.code = this.code;
    metadata.players = this.room.players;
    metadata.maxPlayers = this.room.maxClients;
    const phase = this.phase;
    if (typeof phase === 'string' && phase.length > 0 && phase.length <= MAX_PHASE) metadata.phase = phase;
    return this.room.setMetadata(metadata).then(
      () => undefined,
      () => undefined,
    );
  }
}
