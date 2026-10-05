/**
 * `RoomRegistry` — the live rooms of one room server: the cap, the codes and
 * the numbers `/health` reports.
 */
import { ServerError } from '@colyseus/core';

import type { RoomCodes } from './codes.js';

/** What the registry reads from a live room. */
export interface HostedRoom {
  /** Seats taken, held ones included. */
  readonly players: number;
}

/** What the registry asks before a create: the per-address create limits. */
export interface CreateCharge {
  /**
   * @returns The address the create was charged to, or undefined (a server-side create).
   * @throws {Error} When this create is refused (429).
   */
  chargeCreate(): string | undefined;
  /** @param owner The address a gone room was charged to. */
  releaseCreate(owner: string): void;
}

/** A failed build that means this process's physics is broken: Jolt aborted, or would not start. */
const POISONED = /Aborted\(|module "physics" failed to init/;

/**
 * The HTTP status a refused create answers with, and the SDK's
 * `ServerError.code`: the server is full, try another.
 */
export const ROOM_CAPACITY_CODE = 503;

/**
 * The live rooms of one room server. A room `open`s itself first thing in
 * `onCreate`, before it builds its game, and `close`s itself when it goes, so
 * the cap counts rooms still being built and the ninth create is refused
 * before any game is made.
 *
 * @example
 * ```ts
 * import { createRoomCodes, createRoomRegistry } from 'gameable/rooms/server';
 *
 * const registry = createRoomRegistry(8, createRoomCodes());
 * const code = registry.open(room); // throws a ServerError 503 when 8 are live
 * registry.close(room);
 * ```
 */
export class RoomRegistry {
  private readonly live = new Map<HostedRoom, { code: string; owner: string | undefined }>();
  private brokenBy: string | null = null;

  /**
   * @param maxRooms Rooms this process may hold at once.
   * @param codes The live codes.
   * @param charge The create limit, asked after the cap; none by default.
   */
  constructor(
    readonly maxRooms: number,
    private readonly codes: RoomCodes,
    private readonly charge?: CreateCharge,
  ) {
    if (!Number.isInteger(maxRooms) || maxRooms < 1)
      throw new Error(`RoomRegistry: maxRooms must be a whole number from 1, not ${String(maxRooms)}`);
  }

  /** @returns Live rooms, those still being built included. */
  get size(): number {
    return this.live.size;
  }

  /**
   * @returns Why this process can no longer build rooms (Jolt aborted, or a
   *   room's physics would not start), or null. `/health` is not ok while set.
   */
  get broken(): string | null {
    return this.brokenBy;
  }

  /** @returns Seats taken across every live room. */
  get players(): number {
    let players = 0;
    for (const room of this.live.keys()) players += room.players;
    return players;
  }

  /**
   * @param room A room being created.
   * @returns Its code: a fresh one, also its room id.
   * @throws {ServerError} `ROOM_CAPACITY_CODE` when `maxRooms` rooms are live,
   *   or the charge's error (429) when the requester has created too many.
   */
  open(room: HostedRoom): string {
    if (this.live.size >= this.maxRooms)
      throw new ServerError(
        ROOM_CAPACITY_CODE,
        `room server at capacity: ${String(this.maxRooms)} rooms (maxRooms); try again later`,
      );
    const owner = this.charge?.chargeCreate();
    const code = this.codes.mint();
    this.live.set(room, { code, owner });
    return code;
  }

  /**
   * @param room A room that has gone, or whose create failed. Twice is harmless.
   * @param failure Why its build failed, if it did: a broken physics marks the process broken.
   */
  close(room: HostedRoom, failure?: unknown): void {
    if (failure !== undefined) this.noteFailure(failure);
    const held = this.live.get(room);
    if (held === undefined) return;
    this.live.delete(room);
    this.codes.release(held.code);
    if (held.owner !== undefined) this.charge?.releaseCreate(held.owner);
  }

  /** @param failure Something thrown that may mean Jolt is gone for this process. */
  noteFailure(failure: unknown): void {
    const message = failure instanceof Error ? failure.message : String(failure);
    if (this.brokenBy === null && POISONED.test(message)) this.brokenBy = message;
  }
}

/**
 * @param maxRooms Rooms this process may hold at once.
 * @param codes The live codes.
 * @param charge The create limit, if any.
 * @returns An empty registry.
 *
 * @example
 * ```ts
 * import { createRoomCodes, createRoomRegistry } from 'gameable/rooms/server';
 *
 * const registry = createRoomRegistry(8, createRoomCodes());
 * ```
 */
export function createRoomRegistry(
  maxRooms: number,
  codes: RoomCodes,
  charge?: CreateCharge,
): RoomRegistry {
  return new RoomRegistry(maxRooms, codes, charge);
}
