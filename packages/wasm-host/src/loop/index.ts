/**
 * The `game` module's shared body: one guest tick per fixed step.
 *
 * `GuestLoop` is the base class; the page's `HostLoop` (`adapter/`) and the
 * authority's `ServerLoop` (`server/`) extend it.
 */
export { GuestLoop } from './GuestLoop';
export type { GuestLoopOptions, LoopAdapter, LoopEngine } from './types';
