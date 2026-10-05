/**
 * `gameable/host` — the host half of the wasm game-logic boundary.
 *
 * Loads a `jco transpile`d component, supplies the `gameable:engine/*` imports,
 * encodes `frame-input`, applies `frame-output` to an `EngineAdapter`, and
 * offers the identical `direct` sandbox that runs the same guest with no build
 * step.
 *
 * @example
 * ```ts
 * import { createSandbox, applyOutput, NullEngineAdapter } from 'gameable/host';
 *
 * const adapter = NullEngineAdapter();
 * const sandbox = await createSandbox({ mode: 'direct', game, host });
 * sandbox.init({ seed: 1n, fixedHz: 60, viewportWidth: 1, viewportHeight: 1, devMode: true });
 * applyOutput(adapter, sandbox.tick(input));
 * ```
 */

/**
 * Package identity marker.
 *
 * @example
 * ```ts
 * import { PACKAGE } from 'gameable/host';
 *
 * console.log(PACKAGE); // 'gameable/host'
 * ```
 */
export const PACKAGE = '@gameable/wasm-host' as const;

export { createDirectSandbox, createSandbox } from './sandbox';
export type {
  DirectSandboxOptions,
  GuestNamespace,
  Instantiate,
  Sandbox,
  SandboxOptions,
  WasmSandboxOptions,
} from './sandbox';

export { NullEngineAdapter } from './adapter/EngineAdapter';
export type { AdapterCall, EngineAdapter, NullAdapter } from './adapter/EngineAdapter';

export {
  createEngineAdapter,
  createEngineHost,
  createGameSlot,
  createHostLoop,
} from './engineAdapter';
export type {
  EngineAdapterHandle,
  EngineAdapterOptions,
  EngineHostOptions,
  GameSlot,
  HostLoopOptions,
} from './engineAdapter';

// The `game` module's base class, for a loop of its own (the multiplayer client loop).
export { GuestLoop } from './loop';
export type { GuestLoopOptions, LoopAdapter, LoopEngine } from './loop';
export { copyInputState, createInputSnapshot } from './adapter/inputSnapshot';

export { createDomHud } from './hud';
export type { DomHudOptions, HudDocument, HudElement, HudModel, HudRenderer } from './hud';

export { applyCommand, applyOutput } from './apply';

export { quantizeInput, quantizeSeed } from './abi';

export { createInputEncoder } from './encode-input';
export type { EncodeArgs, InputEncoder, InputSnapshot } from './encode-input';

export { hostBindings } from './host-bindings';
export type { HostBindings } from './host-bindings';

export { minimalWasi } from './wasi-stubs';
export type { MinimalWasiOptions, StderrSink } from './wasi-stubs';
