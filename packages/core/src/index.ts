/**
 * `gameable/core` — the engine host.
 *
 * Owns the canvas, the `WebGPURenderer`, the fixed-step loop, the module
 * registry, the scene graph, the camera rigs and the debug overlay. Game code
 * imports `gameable` instead and never touches this package; application
 * shells — templates, examples, custom hosts — import `createEngine` from here.
 *
 * Every export carries TSDoc and a runnable `@example` at its declaration site.
 *
 * @example
 * ```ts
 * import { createEngine } from 'gameable/core';
 *
 * const engine = await createEngine({
 *   canvas: document.querySelector('canvas')!,
 *   manifest: '/assets/assets.json',
 *   modules: [],
 *   fixedHz: 60,
 *   renderer: { backend: 'auto' },
 * });
 * engine.start();
 * ```
 */

export {
  createEngine,
  DEFAULT_PIXEL_RATIO_CAP,
  isWebGPUBackend,
  resolveEngineConfig,
} from './engine.js';
export type { CreateEngineOptions, Engine, EngineRendererOptions } from './engine.js';

export { createHeadlessEngine } from './headless.js';
export type { CreateHeadlessEngineOptions, HeadlessEngine } from './headless.js';
export { isRenderEngine } from './engine/isRenderEngine.js';

export type {
  EngineCaps,
  EngineConfig,
  EngineContext,
  HostContext,
  RendererBackend,
} from './context.js';
export { requireRenderContext } from './context.js';

export { createModuleRegistry, ModuleError } from './module.js';
export type { EngineModule, EngineServices, ModuleRegistry } from './module.js';

export { createFixedLoop, DEFAULT_FIXED_DT, DEFAULT_MAX_SUBSTEPS } from './loop.js';
export type { FixedLoop, FixedLoopOptions, FrameTiming } from './loop.js';

export { bindFeatures, FeatureError, resolveFeatures } from './features.js';
export type { FeatureLoader, FeatureOptions, FeatureTable, LoadedFeature } from './features.js';

export { createEvents } from './events.js';
export type { EngineEventMap, EventMap, Events, Listener } from './events.js';

export { createTime } from './time.js';
export type { MutableTime, Time } from './time.js';

export { DEFAULT_TRANSFORM_CAPACITY, TransformStore } from './scene/transforms.js';
export { NO_ENTITY, SceneGraph } from './scene/graph.js';

export {
  createFirstPersonRig,
  DEFAULT_EYE_HEIGHT,
  DEFAULT_MAX_PITCH,
} from './camera/firstPerson.js';
export type { FirstPersonRig, FirstPersonRigOptions, Vector3Like } from './camera/firstPerson.js';

export {
  createThirdPersonRig,
  DEFAULT_COLLISION_PADDING,
  DEFAULT_MIN_DISTANCE,
  DEFAULT_PIVOT_HEIGHT,
} from './camera/thirdPerson.js';
export type {
  CollisionProbe,
  ThirdPersonRig,
  ThirdPersonRigOptions,
} from './camera/thirdPerson.js';

export {
  createDebugOverlay,
  DEFAULT_OVERLAY_HOTKEY,
  DEFAULT_OVERLAY_INTERVAL_MS,
} from './debug/overlay.js';
export type { DebugOverlay, DebugOverlayOptions } from './debug/overlay.js';

export { createFrameStats, DEFAULT_SAMPLE_COUNT } from './debug/frameStats.js';
export type { FrameStats } from './debug/frameStats.js';

export {
  DEFAULT_MAX_STORAGE_BUFFERS_PER_SHADER_STAGE,
  initWebGPUPatches,
  isWebGPUPatched,
} from './webgpu/patches.js';
export type { PatchableAdapterPrototype, WebGPUPatchOptions } from './webgpu/patches.js';

export { attachSrgbPass, isSrgbPassMember, SRGB_PASS_LAYER } from './render/srgbPass.js';
export type { SrgbPass, SrgbPassMember, SrgbPassOptions } from './render/srgbPass.js';

/**
 * Package identity marker.
 *
 * @example
 * ```ts
 * import { PACKAGE } from 'gameable/core';
 *
 * console.log(PACKAGE); // 'gameable/core'
 * ```
 */
export const PACKAGE = '@gameable/core' as const;

/**
 * Optional candle intensity animation, independent of frame rate.
 *
 * @example
 * ```ts
 * import { candleFlicker } from 'gameable/core';
 * console.log(candleFlicker(1, 0));
 * ```
 */
export { candleFlicker } from './lighting/candleFlicker.js';
/**
 * Optional rendered-frame counter; the application supplies its styled element.
 *
 * @example
 * ```ts
 * import { createFpsCounter } from 'gameable/core';
 * const dispose = createFpsCounter(engine, document.querySelector('#fps-value')!);
 * ```
 */
export { createFpsCounter } from './debug/fpsCounter.js';
