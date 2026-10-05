/**
 * The options of `createNetClient`.
 */

/**
 * Options for {@link createNetClient}.
 *
 * @example
 * ```ts
 * import type { NetClientOptions } from 'gameable/net/client';
 * const options: NetClientOptions = { name: 'Ana', room: 'KQTX', maxPlayers: 6 };
 * ```
 */
export interface NetClientOptions {
  /** The display name to join with. Defaults to `'player'`. */
  name?: string;
  /** The room code to join; absent joins the connection's default room. */
  room?: string;
  /** The room's seats, as the game declares them. Defaults to 8. */
  maxPlayers?: number;
  /** Rows frames per second the room sends. Defaults to 20. */
  sendHz?: number;
  /** The clock `ping` and `rtt` use, in ms. Defaults to `performance.now`. */
  now?: () => number;
  /**
   * Milliseconds of fixed steps with no server frame before a joined client
   * drops the link and resumes its seat. The room sends a `cmd` every tick,
   * so silence means a dead link the browser has not noticed. Defaults to 2,000.
   */
  silenceMs?: number;
}
