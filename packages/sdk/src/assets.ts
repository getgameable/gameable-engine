/**
 * Manifest lookups.
 *
 * Assets are addressed by **string id only** — never a path, never a URL.
 * `assets.resolve-id` is an init-time import: resolve every name you need in
 * `init` and cache the handle. This module caches for you, so a late lookup
 * costs one map hit, but the first lookup of a name still round-trips.
 */
import { requireRuntime } from './state';
import type { AssetDesc, AssetId } from './types';

/**
 * Resolve a manifest string id to an asset handle, caching the result.
 *
 * @param name The manifest string id, for example `'arena'`.
 * @returns The handle, or 0 when the manifest has no such entry.
 *
 * @example
 * ```ts
 * import { assetId } from 'gameable';
 *
 * const arena = assetId('arena');
 * ```
 */
export function assetId(name: string): AssetId {
  const rt = requireRuntime();
  const cached = rt.assetIds.get(name);
  if (cached !== undefined) return cached;
  const resolved = rt.host.resolveId(name) ?? 0;
  rt.assetIds.set(name, resolved);
  if (resolved === 0) {
    rt.host.log('warn', `asset "${name}" is not in the manifest; add an entry for it`);
  } else if (rt.initialised) {
    rt.host.log(
      'debug',
      `asset "${name}" resolved during tick; resolve names in init() and cache the handle`,
    );
  }
  return resolved;
}

/**
 * Metadata for an asset handle or manifest name.
 *
 * @param idOrName A handle from `assetId`, or a manifest string id.
 * @returns The description, or `null` when the asset is unknown.
 *
 * @example
 * ```ts
 * import { describeAsset } from 'gameable';
 *
 * const desc = describeAsset('myra');
 * if (desc?.kind === 'character') console.log('rig backend', desc.rig);
 * ```
 */
export function describeAsset(idOrName: AssetId | string): AssetDesc | null {
  const rt = requireRuntime();
  const id = typeof idOrName === 'string' ? assetId(idOrName) : idOrName;
  if (id === 0) return null;
  const cached = rt.assetDescs.get(id);
  if (cached !== undefined) return cached;
  // The manifest is immutable for the life of a run, so one crossing per
  // handle is enough; a system may call this every frame without paying for a
  // canonical-ABI round trip and a freshly lifted record each time.
  const desc = rt.host.describe(id) ?? null;
  rt.assetDescs.set(id, desc);
  return desc;
}

/**
 * Ask the host to start loading an asset.
 *
 * @param idOrName A handle or manifest string id.
 * @param priority Higher runs first. Default 0.
 * @returns Nothing.
 *
 * @example
 * ```ts
 * import { loadAsset } from 'gameable';
 *
 * loadAsset('boss-arena', 10);
 * ```
 */
export function loadAsset(idOrName: AssetId | string, priority = 0): void {
  const rt = requireRuntime();
  const id = typeof idOrName === 'string' ? assetId(idOrName) : idOrName;
  if (id === 0) return;
  rt.commands.loadAsset(id, priority);
}
