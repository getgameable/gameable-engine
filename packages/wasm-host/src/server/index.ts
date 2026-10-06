/**
 * `gameable/host/server` — the guest's output applied on an authority.
 *
 * A headless engine runs the same guest a page runs; this entry point gives it
 * an `EngineAdapter` that keeps a world record instead of a scene, and the
 * `HostApi` its sandbox imports. It imports no three.js.
 *
 * It also carries the three-free pieces of the package root a server needs —
 * the sandbox, the game slot and `applyOutput` — so a server never imports
 * `gameable/host` itself, which loads three through `engineAdapter.ts`.
 */
export { createGameSlot } from '../adapter/GameSlot';
export { applyOutput } from '../apply';
export { createDirectSandbox, createSandbox, type Sandbox, type SandboxOptions } from '../sandbox';
export { BodyTable } from './BodyTable';
export { EntityTable } from './EntityTable';
export { createServerAdapter } from './createServerAdapter';
export { ServerAdapter } from './ServerAdapter';
export {
  createServerHost,
  ServerHost,
  type ServerHostAdapter,
  type ServerHostOptions,
} from './ServerHost';
export { createServerLoop, ServerLoop, type ServerLoopOptions } from './ServerLoop';
export { TransientCommands } from './TransientCommands';
export type {
  AnimRecord,
  BodyShapeRecord,
  CharacterRecord,
  DataSink,
  EntityRecord,
  EntitySnapshot,
  InputSource,
  PerPlayerOutput,
  PlayerInput,
  ServerAdapterOptions,
  VisualSnapshot,
  WarnSink,
  WorldSnapshot,
} from './types';
export {
  VisualState,
  type ClipWeightsRecord,
  type ExpressionRecord,
  type LookAtRecord,
  type MaterialParamRecord,
} from './VisualState';
export { WorldAdapter } from './WorldAdapter';
export { WorldRecord, type SpawnFlags, type WorldRecordOptions } from './WorldRecord';
