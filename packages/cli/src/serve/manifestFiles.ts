/**
 * The game's `src/assets.json` on a Node host: the level's collider files
 * found on disk, and a reader for the file URLs a room server resolves.
 */
import { existsSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { resolvePackagedAssetPath } from '@gameable/assets/node';

/** One manifest entry as written on disk (only the fields this file touches). */
export interface RawEntry {
  readonly id: string;
  readonly src: string;
  readonly collider?: { readonly src?: string; readonly [key: string]: unknown };
  readonly [key: string]: unknown;
}

/** `assets.json` as written on disk. */
export interface RawManifest {
  readonly version: 1;
  readonly baseUrl?: string;
  readonly assets: readonly RawEntry[];
}

/**
 * @param gameDir The game's directory.
 * @returns Its `src/assets.json`, or undefined when it has none.
 */
export function readRawManifest(gameDir: string): RawManifest | undefined {
  const path = `${gameDir}/src/assets.json`;
  if (!existsSync(path)) return undefined;
  return JSON.parse(readFileSync(path, 'utf8')) as RawManifest;
}

/**
 * Rewrite every static collider's `src` (the ones a room builds) with
 * `to(entry, path)`, where `path` is the file it names on disk; everything
 * else, `dynamic` and `trigger` colliders included, is left as written.
 *
 * @param raw The manifest.
 * @param gameDir The game's directory, for `@placeholder/` and `public/` sources.
 * @param to The new `src` for a collider file.
 * @returns A copy, `baseUrl` emptied: every static collider `src` is now complete.
 * @throws {Error} When `baseUrl` is not the site root: the page would join it onto
 *   each `src` and this host would not, so the two would read different files.
 */
export function mapColliderFiles(
  raw: RawManifest,
  gameDir: string,
  to: (entry: RawEntry, path: string) => string,
): RawManifest {
  const base = raw.baseUrl ?? '';
  if (base !== '' && base !== '/') {
    throw new Error(
      `src/assets.json has baseUrl "${base}": a room server resolves collider files from the site root ` +
        '(public/ or a package), so use baseUrl "/" and write the folder into each src',
    );
  }
  return {
    version: raw.version,
    baseUrl: '',
    assets: raw.assets.map((entry) => {
      const src = entry.collider?.src;
      const layer = entry.collider?.layer ?? 'static';
      if (src === undefined || layer !== 'static') return entry;
      return { ...entry, collider: { ...entry.collider, src: to(entry, resolvePackagedAssetPath(src, gameDir)) } };
    }),
  };
}

/**
 * The manifest `serve --direct` hands its room: the game's own, with each
 * collider `src` a `file:` URL.
 *
 * @param gameDir The game's directory.
 * @returns The manifest document, or undefined when the game has none.
 */
export function directManifest(gameDir: string): RawManifest | undefined {
  const raw = readRawManifest(gameDir);
  return raw === undefined ? undefined : mapColliderFiles(raw, gameDir, (_e, path) => pathToFileURL(path).href);
}

/**
 * Read a `file:` URL, the way a room on this host reads a collider.
 *
 * @param url A `file:` URL.
 * @returns The file's bytes.
 * @throws {Error} When the URL is not a file, or the file cannot be read.
 */
export async function readFileAsset(url: string): Promise<ArrayBuffer> {
  if (!url.startsWith('file:')) throw new Error(`${url}: a room server reads files, not URLs`);
  const bytes = await readFile(fileURLToPath(url));
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}
