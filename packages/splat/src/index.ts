/**
 * `gameable/splat` — gaussian splat rendering.
 *
 * Two paths that share one renderer and one sort:
 *
 * - **static**, for worlds: `loadSplat` decodes SPZ / PLY / SPLAT / KSPLAT (and glTF
 *   `KHR_gaussian_splatting`) with three's own loaders, and `createSplatObject` puts an
 *   `GaussianSplat` in the scene, or the maintained fork when lighting is requested.
 * - **dynamic**, for characters: `createAnimatedSplat` allocates a fixed capacity of gaussians
 *   with no CPU mirror and hands out the four buffers a compute pass writes into: TSL storage
 *   nodes on either backend, `GPUBuffer`s on WebGPU.
 *
 * The dynamic path rests on a maintained fork of three's `GaussianSplat` in
 * `src/three-fork/`, kept as an insertion-only patch and re-diffed against the pinned three by
 * `scripts/diff-upstream.mjs` on every `npm test`.
 *
 * Every export below carries its own TSDoc and a runnable `@example` at its declaration site.
 */

export {
  AnimatedSplat,
  BYTES_PER_GAUSSIAN,
  createAnimatedSplat,
  SPLAT_RENDER_ORDER,
} from './AnimatedSplat.js';
export type {
  CreateAnimatedSplatOptions,
  SlotRange,
  SplatGPUBuffers,
  SplatSink,
  SplatStorageNodes,
  Vec3Tuple,
} from './AnimatedSplat.js';

export {
  acquireSplatGPUBuffers,
  acquireStorageGPUBuffer,
  backendKind,
  getGPUDevice,
  isWebGPUBackend,
  releaseStorageAttribute,
  SUPPORTED_THREE_VERSION,
} from './backendBuffers.js';

export { createSlotAllocator, SlotAllocationError } from './slots.js';
export type { SlotAllocator } from './slots.js';

export {
  createSplatObject,
  loadSplat,
  parseSplat,
  registerGltfSplatExtension,
  sniffSplatFormat,
  SplatLoadError,
} from './static.js';
export type {
  CreateSplatObjectOptions,
  GltfLoaderLike,
  LoadSplatOptions,
  SplatAsset,
  SplatFormat,
  SplatFormatOption,
} from './static.js';

export { splat } from './module.js';
export { initCountingSortPatch, isCountingSortPatched } from './sortPatch.js';
export type { SplatModuleOptions, SplatService } from './module.js';

export {
  AnimatedGaussianSplat,
  padStorageCapacity,
  SplatUnsupportedError,
} from './three-fork/AnimatedGaussianSplat.js';
export type {
  AnimatedGaussianSplatDescriptor,
  AnimatedGaussianSplatOptions,
  SplatEnvironmentLighting,
  SplatShadowParams,
  SplatShadowReceiverOptions,
} from './three-fork/AnimatedGaussianSplat.js';

/**
 * Package identity marker.
 *
 * @example
 * ```ts
 * import { PACKAGE } from 'gameable/splat';
 *
 * console.log(PACKAGE); // 'gameable/splat'
 * ```
 */
export const PACKAGE = '@gameable/splat' as const;

/**
 * Shared panorama IBL and Gaussian probe lifetime management.
 *
 * @example
 * ```ts
 * import { createEnvironmentProbe } from 'gameable/splat';
 * const lighting = createEnvironmentProbe(engine.scene, engine.renderer, panorama, {
 *   radianceSH: probe.radianceSH,
 * });
 * lighting.dispose();
 * ```
 */
export { createEnvironmentProbe, type EnvironmentProbeOptions } from './environment.js';

/**
 * Shadows that show up by themselves: characters cast onto the place, the place onto the
 * characters, a contact shadow under the feet, from a key light read from the scene. The
 * character bridge (`gameable/host/characters`) starts them for you; use these to drive
 * them yourself.
 *
 * @example
 * ```ts
 * import { createSplatShadows } from 'gameable/splat';
 * const shadows = createSplatShadows(engine.renderer, engine.scene, { quality: 'auto' });
 * shadows.addPlace(placeSplat, { collider });
 * shadows.setQuality('contact');
 * console.log(shadows.info.route, shadows.info.azimuth, shadows.info.elevation);
 * ```
 */
export {
  clusterShadowCasters,
  createSplatShadows,
  defaultShadowQuality,
  parseShadowQuality,
  SHADOW_QUALITIES,
  shadowQualityPreset,
  type KeyLightRoute,
  type ShadowCasterSpot,
  type ShadowCharacter,
  type ShadowDeviceHints,
  type ShadowInfo,
  type ShadowPlace,
  type ShadowQuality,
  type ShadowQualityPreset,
  type SplatShadows,
  type SplatShadowsOptions,
} from './shadows.js';

/**
 * Where a scene's key light comes from, read once from a panorama, a place's own gaussians or a
 * character's own colours. Pure functions; the shadows use them for you.
 *
 * @example
 * ```ts
 * import { estimateKeyLightFromPanorama } from 'gameable/splat';
 * const key = estimateKeyLightFromPanorama({ width, height, data: pixels, scale: 1 / 255, colorSpace: 'srgb' });
 * console.log(key.azimuth, key.elevation, key.shadowStrength);
 * ```
 */
export {
  anglesFromDirection,
  clampElevation,
  DEFAULT_KEY_LIGHT,
  directionFromAngles,
  estimateKeyLightFromPanorama,
  estimateKeyLightFromSurfels,
  panoramaFromGaussians,
  strengthOf,
  type GaussianCloud,
  type GaussianPanoramaOptions,
  type KeyLightEstimate,
  type Panorama,
  type PanoramaKeyLightOptions,
  type SurfelKeyLightOptions,
  type SurfelSamples,
} from './keyLight.js';
