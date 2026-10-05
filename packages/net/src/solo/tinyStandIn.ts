/**
 * A transpiled-guest stand-in that runs the tiny game: a module with the
 * `instantiate` export `jco transpile` emits, whose `game` is the SDK runtime
 * over the tiny-game definition. It goes through `createSandbox({ mode:
 * 'wasm' })` like a component, so Play Solo's rows, rates and boot order are
 * testable in the root suite. It is still the SDK in this realm: never run a
 * direct client guest beside it. Not exported from the package.
 */
import { createGuest, type HostGameConfig } from '@gameable/sdk';

import { loadTinyGame, stubHost } from '../client/clientTesting.js';

/** What happened, in order: the guest pushes `init`; a test pushes its own marks. */
export const bootLog: string[] = [];

/**
 * @returns The `game` namespace, with WIT calling conventions applied.
 */
export async function instantiate(): Promise<Record<string, unknown>> {
  const guest = createGuest(stubHost(), await loadTinyGame());
  return {
    // The versioned key jco emits: the host loads nothing else (wasm-host guestExport).
    'gameable:engine/game@0.2.0': {
      init(config: HostGameConfig): void {
        bootLog.push('init');
        guest.init({
          seed: Number(config.seed),
          fixedHz: config.fixedHz,
          viewportWidth: config.viewportWidth,
          viewportHeight: config.viewportHeight,
          devMode: config.devMode,
          options: config.options ?? undefined,
        });
      },
      tick: guest.tick.bind(guest),
      shutdown: guest.shutdown.bind(guest),
      snapshot: guest.snapshot.bind(guest),
      restore: guest.restore.bind(guest),
    },
  };
}
