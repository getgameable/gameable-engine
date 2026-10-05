/**
 * What `/health` answers.
 */

/**
 * A room server's health: what `GET /health` returns as JSON and
 * `RoomServer.health()` returns as an object.
 *
 * @example
 * ```ts
 * import type { RoomServerHealth } from 'gameable/rooms/server';
 *
 * const health: RoomServerHealth = { ok: true, rooms: 2, players: 5, uptime: 61.2, games: ['my-game'] };
 * ```
 */
export interface RoomServerHealth {
  /** True while the server is listening and not shutting down. */
  readonly ok: boolean;
  /** Live rooms in this process. */
  readonly rooms: number;
  /** Seats taken across them, held ones included. */
  readonly players: number;
  /** Seconds since the server was made. */
  readonly uptime: number;
  /** The catalog: every game this server takes players for, by name. */
  readonly games: readonly string[];
}

/**
 * @param ok Whether the server is serving.
 * @param counts Live rooms and seats.
 * @param counts.size Live rooms.
 * @param counts.players Seats taken.
 * @param startedAt `performance.now()` when the server was made.
 * @param now `performance.now()` now.
 * @param games The catalog's game names.
 * @returns The health.
 *
 * @example
 * ```ts
 * import { readHealth } from 'gameable/rooms/server';
 *
 * const health = readHealth(true, { size: 1, players: 2 }, 0, 1500, ['my-game']); // uptime 1.5
 * ```
 */
export function readHealth(
  ok: boolean,
  counts: { readonly size: number; readonly players: number },
  startedAt: number,
  now: number,
  games: readonly string[] = [],
): RoomServerHealth {
  const uptime = Math.round(now - startedAt) / 1000;
  return { ok, rooms: counts.size, players: counts.players, uptime, games };
}
