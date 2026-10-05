/**
 * The game module's placeholder, so the module list can be built before the engine.
 */
import type { EngineModule } from '@gameable/core';

/** A registered place in the module order, filled in once the engine exists. */
export interface GameSlot {
  /** Register this with `createEngine({ modules })`. */
  readonly module: EngineModule;
  /**
   * Bind the real loop and initialise it.
   *
   * @param loop The module from {@link createHostLoop}.
   * @param ctx The engine context, normally `engine.ctx`.
   * @returns Resolves once the loop's own `init` has run.
   */
  attach(loop: EngineModule, ctx: Parameters<EngineModule['init']>[0]): Promise<void>;
}

/**
 * Reserve the game module's place in the module order.
 *
 * `createEngine` wants its module list up front, and the game module wants the
 * booted engine — the adapter needs `engine.graph`, the host bindings need
 * `engine.assets`. Rather than make every application shell invent a way round
 * that, the slot registers a module that does nothing until
 * {@link GameSlot.attach} hands it the real one.
 *
 * @param order Module order. Defaults to `-50`: after input, before physics,
 *   matching {@link createHostLoop}. The slot's order is the one that counts —
 *   the engine sorts the placeholder, not the loop attached to it.
 * @returns The slot.
 *
 * @example
 * ```ts
 * import { createGameSlot, createHostLoop } from 'gameable/host';
 *
 * const slot = createGameSlot();
 * const engine = await createEngine({ canvas, manifest, modules: [...modules, slot.module] });
 * await slot.attach(createHostLoop(engine, sandbox, adapter), engine.ctx);
 * ```
 */
export function createGameSlot(order = -50): GameSlot {
  let inner: EngineModule | null = null;
  return {
    module: {
      id: 'game',
      order,
      init() {
        // The real loop arrives in `attach`; this only books the hooks.
      },
      fixedUpdate(dt) {
        inner?.fixedUpdate?.(dt);
      },
      update(dt, alpha) {
        inner?.update?.(dt, alpha);
      },
      dispose() {
        inner?.dispose();
      },
    },
    async attach(loop, ctx) {
      await loop.init(ctx);
      inner = loop;
    },
  };
}
