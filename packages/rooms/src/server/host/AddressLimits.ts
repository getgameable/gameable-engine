/**
 * `AddressLimits` — what one client address (a limit key: see `addressKey`)
 * may spend, and the process-wide backstop.
 */
import { type BucketOptions, TokenBuckets } from './TokenBuckets.js';

/**
 * The limits. Every field has a default.
 *
 * @example
 * ```ts
 * import type { GateLimits } from 'gameable/rooms/server';
 *
 * const limits: GateLimits = { misses: { burst: 10, refillMs: 2000 }, roomsPerAddress: 2, seatsPerAddress: 4 };
 * ```
 */
export interface GateLimits {
  /** Failed room lookups per address (by id, by code, reconnect, a bad upgrade). Default 10, then 1 per 2 s. */
  readonly misses?: BucketOptions;
  /** Failed room lookups across every address: the backstop. Default 300, then 5 a second. */
  readonly globalMisses?: BucketOptions;
  /** Rooms created per address. Default 4, then 1 per 15 s: 4 a minute. */
  readonly creates?: BucketOptions;
  /** Live rooms one address may have created. Default 2. */
  readonly roomsPerAddress?: number;
  /** Lobby sockets one address may hold. Default 4. */
  readonly lobbySocketsPerAddress?: number;
  /**
   * Live seats one address may hold across every room, held seats included.
   * Default 4: a household or a demo with a few tabs, not a script holding
   * every room with idle sockets.
   */
  readonly seatsPerAddress?: number;
}

const EVERYONE = '*';

/**
 * Counts by key that go up and down (live rooms, lobby sockets).
 */
class Counts {
  private readonly counts = new Map<string, number>();

  /**
   * @param key The key.
   * @returns Its count.
   */
  of(key: string): number {
    return this.counts.get(key) ?? 0;
  }

  /** @param key The key, one more. */
  add(key: string): void {
    this.counts.set(key, this.of(key) + 1);
  }

  /** @param key The key, one fewer (forgotten at 0). */
  remove(key: string): void {
    const left = this.of(key) - 1;
    if (left > 0) this.counts.set(key, left);
    else this.counts.delete(key);
  }
}

/**
 * The per-address and process-wide limits the gate and the registry spend.
 *
 * @example
 * ```ts
 * import { AddressLimits } from 'gameable/rooms/server';
 *
 * const limits = new AddressLimits({});
 * if (limits.canLookup('203.0.113.7')) limits.missed('203.0.113.7');
 * ```
 */
export class AddressLimits {
  private readonly misses: TokenBuckets;
  private readonly globalMisses: TokenBuckets;
  private readonly creates: TokenBuckets;
  private readonly rooms = new Counts();
  private readonly lobby = new Counts();
  private readonly seats = new Counts();
  private readonly roomsPerAddress: number;
  private readonly lobbySockets: number;
  private readonly seatsPerAddress: number;

  /** @param limits The limits; defaults for the rest. */
  constructor(limits: GateLimits) {
    this.misses = new TokenBuckets(limits.misses ?? { burst: 10, refillMs: 2000 });
    this.globalMisses = new TokenBuckets(limits.globalMisses ?? { burst: 300, refillMs: 200 });
    this.creates = new TokenBuckets(limits.creates ?? { burst: 4, refillMs: 15_000 });
    this.roomsPerAddress = limits.roomsPerAddress ?? 2;
    this.lobbySockets = limits.lobbySocketsPerAddress ?? 4;
    this.seatsPerAddress = limits.seatsPerAddress ?? 4;
  }

  /**
   * @param key The address.
   * @returns True when it, and the process, may still fail a lookup.
   */
  canLookup(key: string): boolean {
    return this.misses.has(key) && this.globalMisses.has(EVERYONE);
  }

  /** @param key The address whose lookup failed: one token from it and one from everyone. */
  missed(key: string): void {
    this.misses.take(key);
    this.globalMisses.take(EVERYONE);
  }

  /**
   * @param key The address creating a room.
   * @returns Why it may not, or null (and the create is counted).
   */
  create(key: string): string | null {
    if (this.rooms.of(key) >= this.roomsPerAddress)
      return `this address already holds ${String(this.roomsPerAddress)} live rooms it created`;
    if (!this.creates.take(key)) return 'too many rooms created from this address; wait a minute';
    this.rooms.add(key);
    return null;
  }

  /** @param key The address whose room has gone. */
  roomGone(key: string): void {
    this.rooms.remove(key);
  }

  /**
   * @param key The address.
   * @returns True when it may open one more lobby socket.
   */
  canJoinLobby(key: string): boolean {
    return this.lobby.of(key) < this.lobbySockets;
  }

  /**
   * @param key The address opening a lobby socket.
   * @returns False when it holds the most it may (nothing is counted then).
   */
  joinLobby(key: string): boolean {
    if (!this.canJoinLobby(key)) return false;
    this.lobby.add(key);
    return true;
  }

  /** @param key The address whose lobby socket closed. */
  leaveLobby(key: string): void {
    this.lobby.remove(key);
  }

  /**
   * @param key The address taking a seat in a room.
   * @returns Why it may not, or null (and the seat is counted).
   */
  takeSeat(key: string): string | null {
    if (this.seats.of(key) >= this.seatsPerAddress)
      return `this address already holds ${String(this.seatsPerAddress)} seats`;
    this.seats.add(key);
    return null;
  }

  /** @param key The address whose seat has gone (left, or its hold expired). */
  leaveSeat(key: string): void {
    this.seats.remove(key);
  }
}
