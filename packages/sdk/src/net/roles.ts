/**
 * Where this guest runs, read once from `game-config.options` in `init`:
 * `{ "net": { "role": "authority" | "client", "localPlayer": 2, "maxPlayers": 8 } }`.
 *
 * No options, or no `net` block, is `solo`: the single-player game every
 * template is today, which is its own authority and its own client.
 */
import { AUTHORITY_SENDER, MAX_PLAYER_ID } from '../wire';

/**
 * Where a guest runs: alone (`solo`), as the room's `authority`, or as one
 * player's `client`.
 *
 * @example
 * ```ts
 * const role: NetRole = ctx.net.role;
 * if (role === 'client') showLatency();
 * ```
 */
export type NetRole = 'solo' | 'authority' | 'client';

/**
 * The highest player id a guest makes a slot for when `net.maxPlayers` is not
 * in `game-config.options`.
 *
 * @example
 * ```ts
 * import { DEFAULT_MAX_PLAYERS } from 'gameable';
 *
 * const options = JSON.stringify({ net: { maxPlayers: DEFAULT_MAX_PLAYERS * 2 } });
 * ```
 */
export const DEFAULT_MAX_PLAYERS = 16;

export { AUTHORITY_SENDER, MAX_PLAYER_ID };

/** The `net` block of `game-config.options`, validated. */
export interface NetConfig {
  role: NetRole;
  /** The player this page belongs to on a client; 0 elsewhere. */
  localPlayer: number;
  /** The highest player id a slot is made for (slots `0..maxPlayers`). */
  maxPlayers: number;
}

/**
 * @param value A candidate id.
 * @returns True for a non-negative integer.
 */
function isId(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

/**
 * Read the `net` block out of `game-config.options`. Init only: it parses JSON.
 *
 * No options, or options without a `net` key, is `solo`. Options that are not
 * JSON, a `net` that is not an object, or a `role` other than `solo`,
 * `authority` or `client` throw: a room that silently ran as `solo` would
 * spawn the wrong players and never send. `localPlayer` is honoured on a
 * client only; `maxPlayers` is clamped to {@link MAX_PLAYER_ID} and raised to
 * cover `localPlayer`.
 *
 * A game that declares its seats (`features.multiplayer.maxPlayers`, read by
 * `roomSeats`) passes them as `seats`: the highest id is then `seats - 1`
 * whatever `net.maxPlayers` says, and a client whose `localPlayer` is past it
 * throws.
 *
 * @param options The options JSON, if any.
 * @param seats The seats the game declares, if it declares any.
 * @returns The validated config.
 * @throws {Error} Naming the bad value, when the options are malformed.
 */
export function parseNetOptions(options: string | undefined, seats?: number): NetConfig {
  const out = parseOptions(options);
  if (seats === undefined) return out;
  const highest = seats - 1;
  if (out.role === 'client' && out.localPlayer > highest) {
    throw new Error(
      `game-config.options net.localPlayer ${String(out.localPlayer)} is past the game's ` +
        `${String(seats)} seats (features.multiplayer.maxPlayers)`,
    );
  }
  out.maxPlayers = highest;
  return out;
}

/**
 * @param options The options JSON, if any.
 * @returns The `net` block, validated, before any declared seats apply.
 * @throws {Error} Naming the bad value, when the options are malformed.
 */
function parseOptions(options: string | undefined): NetConfig {
  const out: NetConfig = { role: 'solo', localPlayer: 0, maxPlayers: DEFAULT_MAX_PLAYERS };
  if (options === undefined) return out;
  let parsed: unknown;
  try {
    parsed = JSON.parse(options) as unknown;
  } catch {
    throw new Error(`game-config.options is not JSON: ${JSON.stringify(options.slice(0, 80))}`);
  }
  if (typeof parsed !== 'object' || parsed === null) return out;
  const block = (parsed as { net?: unknown }).net;
  if (block === undefined || block === null) return out;
  if (typeof block !== 'object') {
    throw new Error(`game-config.options net must be an object, got ${JSON.stringify(block)}`);
  }
  const net = block as { role?: unknown; localPlayer?: unknown; maxPlayers?: unknown };
  const role = net.role;
  if (role === 'authority' || role === 'client') out.role = role;
  else if (role !== undefined && role !== 'solo') {
    throw new Error(
      `game-config.options net.role must be "solo", "authority" or "client", got ${JSON.stringify(role)}`,
    );
  }
  if (isId(net.maxPlayers)) out.maxPlayers = Math.min(net.maxPlayers, MAX_PLAYER_ID);
  if (out.role === 'client' && isId(net.localPlayer) && net.localPlayer <= MAX_PLAYER_ID) {
    out.localPlayer = net.localPlayer;
    if (out.maxPlayers < out.localPlayer) out.maxPlayers = out.localPlayer;
  }
  return out;
}

/**
 * Read `net.maxPlayers` out of `game-config.options`.
 *
 * @param options The options JSON, if any.
 * @param seats The seats the game declares, if any, as {@link parseNetOptions} takes them.
 * @returns The highest player id: `seats - 1` when declared, else the option
 *   clamped to {@link MAX_PLAYER_ID}, else {@link DEFAULT_MAX_PLAYERS}.
 * @throws {Error} When the options are malformed, as {@link parseNetOptions}.
 */
export function parseMaxPlayers(options: string | undefined, seats?: number): number {
  return parseNetOptions(options, seats).maxPlayers;
}
