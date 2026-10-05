/**
 * The page adapter's parts, one concern per file.
 *
 * `engineAdapter.ts` is being cut into this folder a slice at a time; what has
 * moved so far is re-exported here, and the public names are re-exported from
 * `engineAdapter.ts` and the package root as before.
 *
 * `EngineAdapter.ts` holds the interface every adapter implements and the
 * recording `NullEngineAdapter`.
 */
export {
  NullEngineAdapter,
  type AdapterCall,
  type EngineAdapter,
  type NullAdapter,
} from './EngineAdapter';
export { createGameSlot, type GameSlot } from './GameSlot';
export { showErrorOverlay } from './errorOverlay';
export { createHostLoop, type HostLoopOptions } from './HostLoop';
export { HostQueries, type HostQueriesOptions, type PhysicsSource } from './HostQueries';
