/**
 * The guest runtime: the WIT `game` interface implemented over plain JS.
 *
 * One `createGuest` call is one game instance. The same runtime backs both
 * sandbox modes — `mode: 'wasm'` reaches it through
 * `packages/sdk/src/wit/entry.ts`, `mode: 'direct'` calls it in the host's own
 * realm — which is what makes the parity test meaningful: a divergence is a
 * bug, not a configuration difference.
 *
 * Tick order is fixed and documented, because determinism depends on it:
 *
 * 1. decode `frame-input` into preallocated storage, every player's input
 *    into its own slot; apply `player-joined` / `player-left` (on the
 *    authority, spawn or despawn `definition.player` for that player)
 * 2. ingest rigid-body transforms (stride 15) into `Transform` / `Velocity`,
 *    for the guest to read; the host already drew them, so they are not packed
 *    back out
 * 3. built-in look accumulator
 * 4. built-in velocity integration for body-less entities
 * 5. user `systems[]` that run in this role, in declaration order
 * 6. user `update()`
 * 7. built-in camera rig
 * 8. pack `frame-output.transforms` (stride 12) and the command list
 *
 * The pieces are in `guest/`: the context (`context.ts`), the built-in systems
 * (`BuiltinSystems.ts`), `init` (`initGuest.ts`) and `tick` (`tickGuest.ts`).
 */
import { DEFAULT_MAX_ENTITIES, getMaxEntities } from './ecs';
import { createGuestParts, guard, initGuest, tickGuest } from './guest';
import { setLogSink, setRandomSource } from './prelude';
import { readSnapshot, writeSnapshot } from './save';
import {
  checkRealm,
  claimRealm,
  releaseRealm,
  requireRuntime,
  setActiveRuntime,
  type RuntimeState,
} from './state';
import type { GameDefinition } from './defineGame';
import type { FrameInput, FrameOutput, GameConfig, GuestExports, HostApi } from './types';

/** A guest instance: the five WIT exports plus a liveness flag. */
export interface Guest extends GuestExports {
  /** True once the runtime has given up on user code. */
  readonly dead: boolean;
  /** The runtime, for tests and tooling. */
  readonly state: RuntimeState;
}

/**
 * Create a guest from a host and a game definition.
 *
 * @param host The host services, in guest-side JS shapes.
 * @param definition The result of `defineGame`.
 * @returns The five WIT exports, plus `dead` and `state`.
 *
 * @example
 * ```ts
 * import { createGuest } from 'gameable';
 * import { createMockHost, createFrameInput } from 'gameable/test';
 *
 * const guest = createGuest(createMockHost(), game);
 * guest.init({ seed: 1, fixedHz: 60, viewportWidth: 1, viewportHeight: 1, devMode: true });
 * const out = guest.tick(createFrameInput({ frame: 0 }));
 * ```
 */
export function createGuest(host: HostApi, definition: GameDefinition): Guest {
  const parts = createGuestParts(
    host,
    definition,
    definition.world?.maxEntities ?? DEFAULT_MAX_ENTITIES,
  );
  const { rt, ctx } = parts;

  const guestInit = (config: GameConfig): void => {
    initGuest(parts, config);
  };

  const guestTick = (frameInput: FrameInput): FrameOutput => tickGuest(parts, frameInput);

  const guestShutdown = (): void => {
    const previous = setActiveRuntime(rt);
    try {
      const shutdown = definition.shutdown;
      if (shutdown) guard(host, 'shutdown()', shutdown, ctx);
    } finally {
      setActiveRuntime(previous);
      setRandomSource(null);
      setLogSink(null);
      releaseRealm(rt);
    }
  };

  const guestSnapshot = (): Uint8Array => {
    checkRealm(rt);
    const previous = setActiveRuntime(rt);
    try {
      return writeSnapshot(rt, definition.snapshot?.());
    } finally {
      setActiveRuntime(previous);
    }
  };

  const guestRestore = (state: ArrayLike<number>): void => {
    const previous = setActiveRuntime(rt);
    try {
      // Restoring rewrites the component stores: this runtime owns them again.
      claimRealm(rt);
      const user = readSnapshot(rt, state);
      // `readSnapshot` resets the world, which drops every registered query.
      parts.builtins.forgetQuery();
      definition.restore?.(user);
      rt.commands.reset();
      rt.localCommands.reset();
      rt.carryCommands = false;
      rt.dead = false;
      rt.failures = 0;
    } finally {
      setActiveRuntime(previous);
    }
  };

  return {
    init: guestInit,
    tick: guestTick,
    shutdown: guestShutdown,
    snapshot: guestSnapshot,
    restore: guestRestore,
    get dead() {
      return rt.dead;
    },
    state: rt,
  };
}

/**
 * The entity ceiling the built-in components are currently sized for.
 *
 * @returns The configured maximum.
 *
 * @example
 * ```ts
 * import { maxEntities } from 'gameable';
 *
 * console.log(maxEntities()); // 4096
 * ```
 */
export function maxEntities(): number {
  return getMaxEntities();
}

/**
 * The runtime the SDK facades are currently bound to.
 *
 * @returns The active runtime.
 * @throws When called outside `init`, a system, `update` or `shutdown`.
 */
export function activeRuntime(): RuntimeState {
  return requireRuntime();
}
