/**
 * The page's asset plumbing: the bundler-minted URLs for the packaged files,
 * and the manifest rewritten onto them. The arena's collision mesh is in the
 * manifest (`env.arena`'s `collider`), so the authority builds it, in Play
 * Solo and on the room server alike: this page adds no collider of its own.
 *
 * Host code only (it imports `?url` files, Jolt's wasm among them). Split out of
 * `src/main.ts`, as in the third-person template.
 */
import { parseManifest, type AssetManifest } from 'gameable/assets';

import manifestDocument from './assets.json';

// The placeholder pack ships inside `gameable/placeholder`. `?url`
// hands the bundler the file, so it is copied into `dist/` with a hashed name
// — the one thing a bare path in `assets.json` cannot do for you.
import arenaUrl from 'gameable/assets/arena.spz?url';
import colliderUrl from 'gameable/assets/arena.collider.bin?url';
import hitUrl from 'gameable/assets/hit.wav?url';
import pickupUrl from 'gameable/assets/pickup.wav?url';
// The sample character, the same way. It is a 3.1 MB skinned GLB with idle,
// walk, run and wave inside it; every collector wears it.
import aosrigUrl from 'gameable/assets/aosrig_v0.glb?url';
import joltWasm from 'jolt-physics/jolt-physics.wasm.wasm?url';

/** Jolt's wasm, for `physics()` and `loadJolt`. */
export const joltWasmUrl: string = joltWasm;

/** `@placeholder/<file>` in `src/assets.json` resolves through this table. */
const PLACEHOLDER_URLS: Readonly<Record<string, string>> = {
  'arena.spz': arenaUrl,
  'arena.collider.bin': colliderUrl,
  'hit.wav': hitUrl,
  'pickup.wav': pickupUrl,
};

/** `@aosrig/<file>` in `src/assets.json` resolves through this table. */
const AOSRIG_URLS: Readonly<Record<string, string>> = {
  'aosrig_v0.glb': aosrigUrl,
};

/** The `src` prefixes `buildManifest` rewrites, and what each resolves through. */
const PACKAGED_ASSETS: readonly (readonly [string, Readonly<Record<string, string>>])[] = [
  ['@placeholder/', PLACEHOLDER_URLS],
  ['@aosrig/', AOSRIG_URLS],
];

/** The manifest as it is written on disk, before the URLs are filled in. */
interface RawManifest {
  version: 1;
  baseUrl?: string;
  assets: { id: string; src: string; collider?: { src?: string }; rig?: unknown }[];
}

/**
 * Rewrite `@placeholder/...` and `@aosrig/...` sources onto the URLs the
 * bundler minted.
 *
 * Everything else is left alone: drop your own files in `public/` and write
 * their path — `"/models/hero.glb"` — straight into `src/assets.json`.
 *
 * @returns The manifest, validated.
 */
export function buildManifest(): AssetManifest {
  const raw = manifestDocument as unknown as RawManifest;

  /**
   * Resolve one `src`.
   *
   * @param src The manifest `src`.
   * @returns A URL the browser can fetch.
   */
  const resolve = (src: string): string => {
    for (const [prefix, table] of PACKAGED_ASSETS) {
      if (!src.startsWith(prefix)) continue;
      const file = src.slice(prefix.length);
      const url = table[file];
      if (url === undefined) throw new Error(`unknown packaged asset "${src}"`);
      return url;
    }
    return src;
  };

  // Rebuilt field by field rather than spread, because `parseManifest` rejects
  // any key it does not know: add a `$schema` for editor completion and a
  // spread would hand it straight to the validator.
  return parseManifest({
    version: raw.version,
    baseUrl: raw.baseUrl ?? '/',
    assets: raw.assets.map((entry) => ({
      ...entry,
      src: resolve(entry.src),
      collider:
        entry.collider?.src === undefined
          ? entry.collider
          : { ...entry.collider, src: resolve(entry.collider.src) },
    })),
  });
}
