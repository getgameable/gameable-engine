/**
 * `gameable/test` — test doubles for the wasm boundary.
 *
 * A mock host implementing every `gameable:engine` import, host-shaped
 * `frame-input` builders, a frame driver, and the hashes the determinism and
 * parity tests compare.
 *
 * @example
 * ```ts
 * import { createMockHost, createFrameInput, simulate } from 'gameable/test';
 * import { createGuest } from 'gameable';
 *
 * const guest = createGuest(createMockHost(), game);
 * guest.init({ seed: 1, fixedHz: 60, viewportWidth: 1, viewportHeight: 1, devMode: true });
 * const result = simulate(guest, { frames: 120 });
 * ```
 */

/**
 * Package identity marker.
 *
 * @example
 * ```ts
 * import { PACKAGE } from 'gameable/test';
 *
 * console.log(PACKAGE); // 'gameable/test'
 * ```
 */
export const PACKAGE = '@gameable/test-harness' as const;

export { createMockHost } from './mock-host';
export type { LogLine, MockAsset, MockHost, MockHostOptions } from './mock-host';

export {
  createFrameInput,
  createGameConfig,
  createInputState,
  endFrame,
  packBodies,
  press,
  pressMouse,
  release,
  releaseMouse,
} from './frame-input';
export type { FrameInputOverrides, MutableInputState } from './frame-input';

export { simulate } from './simulate';
export type { FrameScript, SimulateOptions, SimulateResult, Tickable } from './simulate';

export { createPlayersInput, PlayersInput } from './players';
export type { PlayerLanes } from './players';

export { simulatePlayers } from './simulatePlayers';
export type {
  PlayersScript,
  PlayerView,
  ReceivedSend,
  SimulatePlayersOptions,
  SimulatePlayersResult,
} from './simulatePlayers';

export {
  hashCommands,
  hashFrameOutput,
  hashString,
  hashTransforms,
  hashU32,
  stableJson,
} from './hash';
