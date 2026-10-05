/**
 * Which `game` namespace a transpiled component hands the host, and the check
 * that it speaks this host's WIT version.
 *
 * jco's root object carries each export twice: under its bare name (`game`)
 * and under its versioned interface name (`gameable:engine/game@0.2.0`). The bare
 * one says nothing about the version, so a guest built against 0.1.0 would
 * load, lift a `frame-output` with no `localCommands`, and throw a TypeError
 * on every step. The versioned key is what tells the two apart.
 */
import type { GuestNamespace } from './sandbox';

/** The WIT package version this host implements. */
export const WIT_VERSION = '0.2.0';

/** The versioned name of the `game` export this host loads. */
export const GAME_EXPORT = `gameable:engine/game@${WIT_VERSION}`;

/** Every versioned `game` export starts with this. */
const GAME_PREFIX = 'gameable:engine/game@';

/**
 * @param root What the transpiled module's `instantiate` resolved to.
 * @returns The `game` namespace to wrap.
 * @throws {Error} When the component exports `gameable:engine/game` at another
 *   version (a guest built before the host moved on), or no `game` at all.
 */
export function gameNamespace(root: object): GuestNamespace {
  const exports = root as Record<string, unknown>;
  const current = exports[GAME_EXPORT];
  if (current !== undefined) return current as GuestNamespace;
  const other = Object.keys(exports).filter((key) => key.startsWith(GAME_PREFIX));
  if (other.length > 0) {
    throw new Error(
      `guest built for ${other.join(', ')}; this host speaks gameable:engine ${WIT_VERSION}; ` +
        'rebuild it (npm run build:guest)',
    );
  }
  throw new Error(`the guest module exports no ${GAME_EXPORT}; rebuild it (npm run build:guest)`);
}
