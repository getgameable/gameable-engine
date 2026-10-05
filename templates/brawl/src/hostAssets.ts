/**
 * The page's asset plumbing: the bundler-minted URLs for the packaged files,
 * the manifest rewritten onto them, and the arena's collision mesh.
 *
 * Host code only (it imports `?url` files and Jolt), split out of
 * `src/main.ts` so Play Solo's authority (`src/solo.ts`) can share it.
 */
import { parseManifest, type AssetManifest } from 'gameable/assets';
import { parseCollider } from 'gameable/placeholder';
import { loadJolt, meshShapeFromGeometry, type PhysicsService } from 'gameable/physics';

import manifestDocument from './assets.json';

// The placeholder pack ships inside `gameable/placeholder`. `?url`
// hands the bundler the file, so it is copied into `dist/` with a hashed name
// — the one thing a bare path in `assets.json` cannot do for you.
import arenaUrl from 'gameable/assets/arena.spz?url';
import colliderUrl from 'gameable/assets/arena.collider.bin?url';
import hitUrl from 'gameable/assets/hit.wav?url';
// The sample character, the same way. It is a 3.1 MB skinned GLB with idle,
// walk, run and wave inside it; every fighter wears it.
import aosrigUrl from 'gameable/assets/aosrig_v0.glb?url';
import joltWasm from 'jolt-physics/jolt-physics.wasm.wasm?url';

/** Jolt's wasm, for `physics()` and `loadJolt`. */
export const joltWasmUrl: string = joltWasm;

/** `@placeholder/<file>` in `src/assets.json` resolves through this table. */
const PLACEHOLDER_URLS: Readonly<Record<string, string>> = {
  'arena.spz': arenaUrl,
  'arena.collider.bin': colliderUrl,
  'hit.wav': hitUrl,
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

/**
 * Body id for the arena's static collision mesh on this page's own physics
 * world, which holds only it and this player's predicted body. The guest mints from 1 up. A room's authority (Play
 * Solo, `gameable serve`) builds the manifest's colliders itself, in ids just
 * above its `maxBodies`, so this page adds the mesh only to its own world.
 */
export const PAGE_ENVIRONMENT_BODY = 1_000_000;

/** `staticGeometry` is bit 1 of the WIT `collision-layers` flags. */
const LAYER_STATIC_GEOMETRY = 1 << 1;

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

/**
 * Load the arena's collision mesh and give it to the physics world.
 *
 * A splat is scenery — there is no geometry in it a solver can use — so the
 * arena ships a baked triangle mesh alongside it. One static body, built once.
 *
 * @param world The physics service.
 * @param id The body id; {@link PAGE_ENVIRONMENT_BODY} by default.
 * @returns Resolves once the body is in the world.
 */
export async function addEnvironmentCollider(
  world: PhysicsService,
  id = PAGE_ENVIRONMENT_BODY,
): Promise<void> {
  const response = await fetch(colliderUrl);
  if (!response.ok) throw new Error(`collider ${colliderUrl}: HTTP ${String(response.status)}`);
  const mesh = parseCollider(await response.arrayBuffer());
  const jolt = await loadJolt({ wasmUrl: joltWasmUrl });
  const shape = meshShapeFromGeometry(jolt, mesh.positions, mesh.indices);
  world.addBody({
    id,
    shape: 'mesh',
    dims: [],
    position: [0, 0, 0],
    rotation: [0, 0, 0, 1],
    mass: 0,
    kind: 'static',
    layer: LAYER_STATIC_GEOMETRY,
    mask: 0xffff,
    friction: 0.8,
    restitution: 0,
    geometry: shape,
  });
  // The world took its own reference; ours is done with it.
  shape.Release();
}
