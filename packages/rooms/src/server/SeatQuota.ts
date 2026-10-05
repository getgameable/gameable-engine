/**
 * `SeatQuota` — one room's share of the per-address seat limit: which
 * address each of its seats was charged to.
 */
import { ServerError } from '@colyseus/core';

import type { AddressLimits } from './host/AddressLimits.js';

/** The join option the request gate writes with the client's limit key (`PEER_OPTION`). */
const PEER = 'aosPeer';
const TOO_MANY = 429;

/**
 * Charges each seat to the address that joined it (`PEER_OPTION`, written by
 * the request gate over anything the client sent), and gives it back when
 * the seat goes: a leave, a hold that expired, the room's end. A held seat
 * still counts. Without limits (a bare `Server`) nothing is counted.
 *
 * @example
 * ```ts
 * import { AddressLimits, SeatQuota } from 'gameable/rooms/server';
 *
 * const quota = new SeatQuota(new AddressLimits({ seatsPerAddress: 4 }));
 * quota.take('session-a', { aosPeer: '203.0.113.7' }); // throws 429 past 4
 * quota.release('session-a');
 * ```
 */
export class SeatQuota {
  private readonly owners = new Map<string, string>();

  /** @param limits The server's address limits, or undefined for none. */
  constructor(private readonly limits: AddressLimits | undefined) {}

  /**
   * @param sessionId The session taking a seat.
   * @param options Its join options.
   * @throws {ServerError} 429 when its address holds all the seats it may.
   */
  take(sessionId: string, options: Record<string, unknown> | undefined): void {
    const key = options?.[PEER];
    if (this.limits === undefined || typeof key !== 'string') return;
    const refused = this.limits.takeSeat(key);
    if (refused !== null) throw new ServerError(TOO_MANY, refused);
    this.owners.set(sessionId, key);
  }

  /** @param sessionId A session whose seat has gone. Twice is harmless. */
  release(sessionId: string): void {
    const key = this.owners.get(sessionId);
    if (key === undefined) return;
    this.owners.delete(sessionId);
    this.limits?.leaveSeat(key);
  }

  /** The room has gone: every seat it still charged is given back. */
  dispose(): void {
    for (const key of this.owners.values()) this.limits?.leaveSeat(key);
    this.owners.clear();
  }
}
