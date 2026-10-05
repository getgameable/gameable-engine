/**
 * `createHeadlessEngine` — the engine without a renderer: the module registry,
 * the fixed loop, the clock, the events and the asset registry, driven by a
 * timer or by hand. The authority of a multiplayer room runs on this (ADR 0018).
 *
 * This file is also the `gameable/core/headless` entry point: the server's
 * door into core. The package root loads three.js (the renderer engine); this
 * entry re-exports only the three-free pieces a server needs.
 */
import type { AssetManifest, AssetRegistry } from '@gameable/assets';
import { createAssetRegistry } from '@gameable/assets';

import type { EngineCaps, EngineConfig, HostContext } from './context.js';
import { HeadlessEngine as HeadlessEngineImpl } from './engine/HeadlessEngine.js';
import { resolveManifest } from './engine/manifest.js';
import type { EngineEventMap, Events } from './events.js';
import type { FixedLoop, FrameTiming } from './loop.js';
import { DEFAULT_MAX_SUBSTEPS } from './loop.js';
import type { EngineModule, EngineServices, ModuleRegistry } from './module.js';
import type { Time } from './time.js';

/** Options for {@link createHeadlessEngine}. */
export interface CreateHeadlessEngineOptions {
  /**
   * The asset manifest: a URL to fetch, or an already-parsed document. Omit for
   * an empty registry. No loaders are registered; add them with
   * `engine.assets.registerLoader(...)`.
   */
  readonly manifest?: string | AssetManifest | object;
  /** Modules to register, in any order; `order` decides the run order. */
  readonly modules?: readonly EngineModule[];
  /** Simulation rate. Defaults to `60`. */
  readonly fixedHz?: number;
  /** Most fixed steps one `step` may run. Defaults to `5`. */
  readonly maxSubsteps?: number;
}

/** An engine with no renderer. */
export interface HeadlessEngine {
  /** The module context: a `HostContext`, with no scene, camera or renderer. */
  readonly ctx: HostContext;
  /** The module registry. */
  readonly modules: ModuleRegistry;
  /** The engine event bus. */
  readonly events: Events<EngineEventMap>;
  /** The fixed-step loop. */
  readonly loop: FixedLoop;
  /** The asset registry. */
  readonly assets: AssetRegistry;
  /** The engine clock; the same object as `ctx.time`. */
  readonly time: Time;
  /** Whether the timer is running. */
  readonly running: boolean;

  /**
   * Advance by hand.
   *
   * @param nowMs A monotonic wall clock in milliseconds; the first call is the baseline.
   * @returns What the frame did. The same record every call; do not retain it.
   */
  step(nowMs: number): FrameTiming;

  /** Tick on a timer, aiming each step at its due time (no drift). */
  start(): void;

  /** Stop the timer. Modules keep their resources; `start` resumes. */
  stop(): void;

  /**
   * Stop, then dispose modules in reverse order, the assets and the listeners.
   *
   * @returns Resolves once everything is released.
   */
  dispose(): Promise<void>;

  /**
   * Look up a module's service.
   *
   * @param id Service id, typed through `EngineServices`.
   * @returns The service.
   */
  get<K extends keyof EngineServices>(id: K): EngineServices[K];
}

/**
 * Boot an engine with no renderer.
 *
 * @param options Manifest, modules and the loop rate.
 * @returns The engine; call `start()` or drive `step()` yourself.
 *
 * @example
 * ```ts
 * import { createHeadlessEngine } from 'gameable/core/headless';
 *
 * const engine = await createHeadlessEngine({ modules: [], fixedHz: 60 });
 * engine.step(0);
 * engine.step(1000 / 60); // one fixed step
 * console.log(engine.time.elapsed); // 0.016666…
 * await engine.dispose();
 * ```
 */
export async function createHeadlessEngine(
  options: CreateHeadlessEngineOptions = {},
): Promise<HeadlessEngine> {
  const fixedHz = options.fixedHz ?? 60;
  if (!(fixedHz > 0)) throw new RangeError('createHeadlessEngine: fixedHz must be greater than 0');
  const config: EngineConfig = {
    fixedHz,
    fixedDt: 1 / fixedHz,
    maxSubsteps: options.maxSubsteps ?? DEFAULT_MAX_SUBSTEPS,
    backend: 'webgl',
    antialias: false,
    pixelRatioCap: 1,
    debug: false,
    headless: true,
  };
  const caps: EngineCaps = { webgpu: false, characters: false };
  const manifest = await resolveManifest(options.manifest);
  const assets = createAssetRegistry({ manifest, loaders: {} });
  return HeadlessEngineImpl.create({ config, caps, assets }, options.modules ?? []);
}

// The three-free half of the core API, for server code that must not load three.
export { bindFeatures, FeatureError, resolveFeatures } from './features.js';
export type { FeatureLoader, FeatureOptions, FeatureTable, LoadedFeature } from './features.js';
export { ModuleError } from './module.js';
export type { EngineModule, EngineServices, ModuleRegistry } from './module.js';
export { requireRenderContext } from './context.js';
export type { EngineContext, HostContext } from './context.js';
