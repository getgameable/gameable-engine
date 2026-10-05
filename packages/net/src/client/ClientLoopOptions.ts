/**
 * What `createClientLoop` takes: the client guest's seed and viewport, where
 * its own entity ids start, the death callback, and whether the page predicts.
 */
import type { GuestLoopOptions } from '@gameable/wasm-host';

/**
 * Options for `createClientLoop`.
 *
 * @example
 * ```ts
 * import type { ClientLoopOptions } from 'gameable/net/client';
 * const options: ClientLoopOptions = { seed: 7, onDead: (error) => console.error(error) };
 * ```
 */
export interface ClientLoopOptions extends GuestLoopOptions {
  /** The client guest's run seed. Defaults to `0x5eed1234`, as on the page. */
  seed?: bigint | number;
  /** Value of `game-config.dev-mode`. Defaults to true. */
  devMode?: boolean;
  /** The viewport the guest's `init` is told. Defaults to 0 x 0. */
  viewport?: { width: number; height: number };
  /**
   * Where the client guest's own entity ids start on the page: its entity
   * `e` is drawn as `entityBase + e`, past every authority id. Pass the game's
   * `world.maxEntities`. Defaults to the SDK's `DEFAULT_MAX_ENTITIES`.
   */
  entityBase?: number;
  /** Called once when the loop dies (the guest trapped, or applying the world threw). Defaults to `console.error`. */
  onDead?: (error: Error | null) => void;
  /**
   * Predict this page's own character body (`features.multiplayer.predict`):
   * the page registers `physics()` with only the level's static colliders,
   * the client guest walks its own character body in it, and the authority's
   * trailers correct it. Default false: the page never steps physics.
   */
  predict?: boolean;
}
