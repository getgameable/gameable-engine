/**
 * `features` — what optional engine modules a game declares it needs.
 *
 * The host reads this before the guest exists and loads exactly those
 * modules (see `resolveFeatures` in `gameable/core`). A feature that is
 * absent or `false` is not loaded and not downloaded.
 */
import type { GameDefinition } from './defineGame';

/** Options for the `multiplayer` feature. */
export interface MultiplayerOptions {
  /**
   * Seats in a room, ids `0..maxPlayers - 1`. Default 8. `roomSeats` reads
   * it, for the guest's player slots and for the room's door alike.
   */
  maxPlayers?: number;
  /** Transform rows per second sent to each player. Default 20. */
  sendHz?: number;
  /**
   * Predict each page's own character body: the page steps its own Jolt
   * world (the level's static colliders and the body its client guest adds
   * for its player) so the player moves on key-down, and the authority's
   * rows correct it. Default false. See the multiplayer concept page.
   */
  predict?: boolean;
}

/** The features a game may declare. A key that is `false` is the same as absent. */
export interface FeatureSpec {
  /** The splat character bridge (`spawn-character` and friends). */
  characters?: boolean;
  /** Rooms, players and replication. */
  multiplayer?: boolean | MultiplayerOptions;
}

/** Declared features, normalised: every present feature has an options object. */
export type FeatureOptions = Readonly<Record<string, Readonly<Record<string, unknown>>>>;

/**
 * Normalise a game's `features` block.
 *
 * @param definition The `defineGame` result.
 * @returns A frozen table: feature name to its options; `true` becomes `{}`, `false` is dropped.
 *
 * @example
 * ```ts
 * import { defineGame, featuresOf } from 'gameable';
 *
 * const game = defineGame({ features: { characters: true, multiplayer: { maxPlayers: 6 } } });
 * console.log(featuresOf(game)); // { characters: {}, multiplayer: { maxPlayers: 6 } }
 * ```
 */
export function featuresOf(definition: GameDefinition): FeatureOptions {
  const out: Record<string, Readonly<Record<string, unknown>>> = {};
  const spec = (definition.features ?? {}) as Record<string, unknown>;
  for (const [name, value] of Object.entries(spec)) {
    if (value === false || value === undefined || value === null) continue;
    out[name] = Object.freeze(value === true ? {} : { ...(value as Record<string, unknown>) });
  }
  return Object.freeze(out);
}
