/**
 * `gameable/assets` — the `assets.json` manifest and the asset registry.
 *
 * Assets are addressed by **string id only**. The registry is the single place
 * that knows a URL; game logic asks for `'arena'` and never for a path. Every
 * export below carries its own TSDoc and a runnable `@example` at its
 * declaration site.
 *
 * @example
 * ```ts
 * import { createAssetRegistry, createDefaultLoaders, parseManifest } from 'gameable/assets';
 *
 * const manifest = parseManifest({
 *   version: 1,
 *   baseUrl: '/assets/',
 *   assets: [{ id: 'arena', type: 'gltf', src: 'arena.glb', tags: ['world'] }],
 * });
 * const assets = createAssetRegistry({ manifest, loaders: createDefaultLoaders().loaders });
 * await assets.preload('world');
 * ```
 */

export {
  findEntry,
  joinUrl,
  loadManifest,
  ManifestError,
  parseManifest,
  resolveAssetUrl,
} from './manifest.js';

export type {
  AssetCollider,
  AssetEntry,
  AssetManifest,
  AssetRig,
  AssetType,
  ColliderLayer,
  ColliderShape,
  ExpressionSegment,
  ExpressionSpace,
  ExpressionSpaceKind,
  LoadManifestOptions,
  ParseManifestOptions,
  RigBackend,
  Vec3,
} from './manifest.js';

export { AssetError, createAssetRegistry } from './registry.js';

export type {
  AssetLoader,
  AssetLoaderContext,
  AssetLoaderMap,
  AssetProgress,
  AssetRegistry,
  CreateAssetRegistryOptions,
} from './registry.js';

export {
  createAudioLoader,
  createDefaultLoaders,
  createGltfLoader,
  DEFAULT_DRACO_DECODER_PATH,
} from './loaders.js';

export type {
  AudioLoaderOptions,
  DefaultLoaderOptions,
  DefaultLoaders,
  GltfLoaderHandle,
  GltfLoaderOptions,
} from './loaders.js';

/**
 * Package identity marker.
 *
 * @example
 * ```ts
 * import { PACKAGE } from 'gameable/assets';
 *
 * console.log(PACKAGE); // 'gameable/assets'
 * ```
 */
export const PACKAGE = '@gameable/assets' as const;
