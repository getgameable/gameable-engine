/**
 * The adapter shape the client loop applies the authority's world to. The
 * page's `EngineAdapterHandle` has every member; a test passes a recording
 * one.
 */
import type { Entity } from '@gameable/sdk';
import type { LoopAdapter } from '@gameable/wasm-host';

/**
 * What `createClientLoop` needs of its adapter.
 *
 * @example
 * ```ts
 * import type { ClientLoopAdapter } from 'gameable/net/client';
 * import { createEngineAdapter } from 'gameable/host';
 * const adapter: ClientLoopAdapter = createEngineAdapter(engine, { modules });
 * ```
 */
export interface ClientLoopAdapter extends LoopAdapter {
  /** Roll current transforms into previous ones; first thing in every fixed step. */
  beginFixedStep(): void;
  /**
   * Write one replicated row: the lanes its `RowFlag` bits name (position,
   * rotation, scale), a snap on `TELEPORT`, a show on `VISIBLE`. Lanes the
   * row does not carry keep their current values. An unknown entity is ignored.
   */
  setTransformFromHost(
    entity: Entity,
    flags: number,
    position: ArrayLike<number>,
    rotation: ArrayLike<number>,
    scale: ArrayLike<number>,
  ): void;
  /** One rendered frame's adapter work (interpolation, characters); optional. */
  update?(dt: number, alpha: number): void;
}
