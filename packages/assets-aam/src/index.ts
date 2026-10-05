/**
 * `gameable/aam` — the optional AvatarOS Asset Manager adapter.
 *
 * Four pieces, each independently usable:
 *
 * - {@link createAamClient} — the HTTP client. Holds the key, attaches it to
 *   AAM URLs only, retries 5xx with exponential backoff, and can serve file
 *   bytes from Cache Storage.
 * - {@link buildCharacterManifestEntries} and {@link mergeManifests} — turn an
 *   AAM character into ordinary `assets.json` entries, merged at runtime, so
 *   **game logic still addresses assets by string id only**.
 * - {@link createAamResolver} — the `fetch` option for `loadManifest` and the
 *   character bundle loader.
 * - {@link aamConfigFromEnv} — reads `VITE_ASSET_MANAGER_URL` and
 *   `VITE_ASSET_MANAGER_API_KEY`, returning `null` when the adapter is not in
 *   use.
 *
 * Every export carries its own TSDoc and a runnable `@example` at its
 * declaration site.
 *
 * @example
 * ```ts
 * import { parseManifest } from 'gameable/assets';
 * import {
 *   aamConfigFromEnv,
 *   buildCharacterManifestEntries,
 *   createAamClient,
 *   createAamResolver,
 *   mergeManifests,
 * } from 'gameable/aam';
 *
 * const base = parseManifest({ version: 1, baseUrl: '/assets/', assets: [] });
 * const config = aamConfigFromEnv();
 * if (config !== null) {
 *   const client = createAamClient({ ...config, cache: 'cache-storage' });
 *   const built = await buildCharacterManifestEntries(client, 'myra');
 *   const manifest = mergeManifests(base, built.entries);
 *   const resolver = createAamResolver(client);
 *   console.log(manifest.assets.length, resolver.fetch !== undefined);
 * }
 * ```
 */

export { AamError, createAamClient } from './client.js';

export type {
  AamBundleFile,
  AamCacheMode,
  AamCharacterBundle,
  AamClient,
  AamClientOptions,
  AamFetchFileOptions,
  AdditiveType,
  AnimationAssetRow,
  AnimationClipKind,
  BasePoseType,
} from './client.js';

export { buildCharacterManifestEntries, mergeManifests } from './manifest.js';

export type {
  AamCharacterEntries,
  AamFaceClip,
  BuildCharacterManifestOptions,
} from './manifest.js';

export { createAamResolver } from './resolver.js';

export type { AamResolver } from './resolver.js';

export { aamConfigFromEnv } from './env.js';

export type { AamEnvConfig } from './env.js';

/**
 * Package identity marker.
 *
 * @example
 * ```ts
 * import { PACKAGE } from 'gameable/aam';
 *
 * console.log(PACKAGE); // 'gameable/aam'
 * ```
 */
export const PACKAGE = '@gameable/assets-aam' as const;
