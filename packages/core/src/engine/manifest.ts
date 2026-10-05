/**
 * The `manifest` option, shared by `createEngine` and `createHeadlessEngine`.
 */
import type { AssetManifest } from '@gameable/assets';
import { loadManifest, parseManifest } from '@gameable/assets';

/**
 * Turn the `manifest` option into a registry-ready manifest.
 *
 * @param manifest A URL, a parsed manifest, or a raw JSON document. Omitted
 *   means an empty registry.
 * @returns The validated manifest.
 */
export async function resolveManifest(
  manifest: string | AssetManifest | object | undefined,
): Promise<AssetManifest> {
  if (manifest === undefined) return parseManifest({ version: 1, assets: [] });
  if (typeof manifest === 'string') return loadManifest(manifest);
  return parseManifest(manifest);
}
