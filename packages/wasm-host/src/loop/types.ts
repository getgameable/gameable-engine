/**
 * The engine, adapter and option shapes a `GuestLoop` works over.
 */
import type { EngineEventMap, Events, ModuleRegistry } from '@gameable/core';
import type { GameEvent } from '@gameable/sdk';

import type { EngineAdapter } from '../adapter/EngineAdapter';

/**
 * The two parts of an engine a loop uses: the module registry and the event bus.
 *
 * Both the page's `Engine` and a `HeadlessEngine` have them.
 *
 * @example
 * ```ts
 * const engine: LoopEngine = await createHeadlessEngine({ manifest, modules });
 * ```
 */
export interface LoopEngine {
  /** Where the `physics` service is looked up. */
  readonly modules: ModuleRegistry;
  /** Where `physics:stepped` is announced. */
  readonly events: Events<EngineEventMap>;
}

/**
 * What a loop needs of its adapter beyond the `EngineAdapter` commands.
 *
 * @example
 * ```ts
 * const adapter: LoopAdapter = createServerAdapter(engine.modules.get('physics'));
 * ```
 */
export interface LoopAdapter extends EngineAdapter {
  /** The host event queue; drained into each tick's `frame-input.events`. */
  readonly events: GameEvent[];
  /** Write the post-step body rows onto the entities they drive. */
  applyBodyRows(rows: Float32Array, count: number): void;
  /** Release the adapter. */
  dispose(): void;
}

/**
 * Options every loop takes.
 *
 * @example
 * ```ts
 * const options: GuestLoopOptions = { maxBodies: 2048, order: -50 };
 * ```
 */
export interface GuestLoopOptions {
  /** Body rows the input encoder reserves before it grows. Defaults to 1024. */
  maxBodies?: number;
  /** Module order. Defaults to `-50`: after input, before physics. */
  order?: number;
}
