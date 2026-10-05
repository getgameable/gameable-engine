/**
 * `RoomLifecycle` — Colyseus's hooks, made safe: each call into the game
 * goes through the room's `RoomCrash`, and the listing follows the seats.
 */
import type { PlayerIdentity } from '@gameable/net/server';
import type { Client } from '@colyseus/core';

import type { RoomCrash } from './RoomCrash.js';
import type { RoomListing } from './RoomListing.js';
import type { RoomParts } from './RoomParts.js';

/**
 * The bodies of `onJoin`, `onDrop`, `onReconnect`, `onLeave` and the welcome.
 * A throw in any of them (a game whose `join` or `leave` throws, a welcome
 * that cannot be built) crashes that room alone and returns; none of them
 * rethrows, because Colyseus calls some (`onLeave` on an expired hold) outside
 * any try, where a rethrow would reach the process.
 *
 * @example
 * ```ts
 * import { RoomLifecycle } from 'gameable/rooms/server';
 *
 * const lifecycle = new RoomLifecycle(() => parts, crash, listing);
 * lifecycle.leave('session-a', 4000);
 * ```
 */
export class RoomLifecycle {
  /**
   * @param parts The room's parts, or null before they are built.
   * @param failure The room's crash state.
   * @param listing The room's listing, re-published when the seats change.
   */
  constructor(
    private readonly parts: () => RoomParts | null,
    private readonly failure: RoomCrash,
    private readonly listing: RoomListing,
  ) {}

  /**
   * @param sessionId The Colyseus session.
   * @param name The seat's name.
   * @param identity Who the player is, when the room resolved it.
   */
  join(sessionId: string, name: unknown, identity: PlayerIdentity | null = null): void {
    const joined = this.failure.run('onJoin', () => {
      this.parts()?.seating.join(sessionId, name, identity);
    });
    if (joined) void this.listing.publish();
  }

  /**
   * @param sessionId The Colyseus session.
   * @param code The close code.
   * @returns True when the seat is held: the room then allows a reconnection.
   */
  drop(sessionId: string, code: number | undefined): boolean {
    return (
      this.failure.attempt('onDrop', () => this.parts()?.seating.drop(sessionId, code)) === true
    );
  }

  /** @param sessionId The Colyseus session. */
  resume(sessionId: string): void {
    this.failure.run('onReconnect', () => {
      this.parts()?.seating.resume(sessionId);
    });
  }

  /**
   * Also where an expired hold lands.
   *
   * @param sessionId The Colyseus session.
   * @param code The close code.
   */
  leave(sessionId: string, code: number | undefined): void {
    const left = this.failure.run('onLeave', () => {
      this.parts()?.seating.leave(sessionId, code);
    });
    if (left) void this.listing.publish();
  }

  /**
   * The room's dispose: the slot first (a game whose dispose throws still frees
   * it), then the game, whose throw is logged.
   *
   * @param label The room, for the log.
   */
  dispose(label: string): void {
    this.listing.release();
    try {
      this.parts()?.game.dispose();
    } catch (error) {
      console.error(`[rooms] room ${label}: game.dispose threw`, error);
    }
  }

  /**
   * @param client The client being welcomed.
   * @returns Its welcome, or `error: ended` / `crashed` once the room has crashed.
   */
  welcome(client: Client): Uint8Array {
    const parts = this.parts();
    if (parts === null) throw new Error('GameableColyseusRoom: a welcome before onCreate');
    const welcome = this.failure.attempt('welcomeFor', () => parts.replication.welcomeFor(client));
    return welcome ?? parts.replication.wire.error('ended', 'crashed');
  }
}
