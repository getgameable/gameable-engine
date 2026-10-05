/**
 * The level's static colliders, from the manifest: every entry whose
 * `collider` is static (the default layer) becomes one static Jolt body,
 * built by the host before the guest's `init`.
 *
 * Host-owned ids: the guest mints body ids 1 to `maxBodies`; the level takes
 * the dense range just above, `maxBodies + 1` to `maxBodies + n`, and the
 * Jolt world is made for `maxBodies + n` bodies, so the level never costs
 * the guest an id. The ids stay near `maxBodies` on purpose: physics-jolt's
 * overlap query keeps one stamp per body id.
 */
import {
  type AssetCollider,
  type AssetManifest,
  joinUrl,
  loadManifest,
  parseManifest,
} from '@gameable/assets';
import { parseCollider } from '@gameable/assets-placeholder';
import {
  type BodyArgs,
  loadJolt,
  meshShapeFromGeometry,
  type PhysicsOptions,
  type PhysicsService,
} from '@gameable/physics-jolt';

/** `staticGeometry` is bit 1 of the WIT `collision-layers` flags. */
const LAYER_STATIC_GEOMETRY = 1 << 1;

/** Reads one file the manifest names (a collider's `src`), by its resolved URL. */
export type ReadAsset = (url: string) => Promise<ArrayBuffer>;

/** How {@link addLevelColliders} reads and builds. */
export interface LevelColliderOptions {
  /** Reads a collider's resolved `src`. Default `fetch`. */
  readonly readAsset?: ReadAsset;
  /** The room's Jolt options, for where Jolt's wasm lives. */
  readonly physics?: PhysicsOptions;
}

/** One static collider and the entry that declares it. */
export interface LevelCollider {
  /** The entry's id, for error messages. */
  readonly id: string;
  /** The collider as the manifest declares it. */
  readonly collider: AssetCollider;
}

/**
 * @param manifest A manifest URL, a document, or nothing.
 * @returns The validated manifest (an empty one for nothing).
 */
export async function resolveRoomManifest(manifest: string | object | undefined): Promise<AssetManifest> {
  if (manifest === undefined) return parseManifest({ version: 1, assets: [] });
  if (typeof manifest === 'string') return loadManifest(manifest);
  return parseManifest(manifest);
}

/**
 * @param manifest The validated manifest.
 * @returns Its static colliders, in manifest order (`dynamic` and `trigger` ones are not the level's).
 */
export function staticColliders(manifest: AssetManifest): LevelCollider[] {
  const out: LevelCollider[] = [];
  for (const entry of manifest.assets) {
    const collider = entry.collider;
    if (collider === undefined || (collider.layer ?? 'static') !== 'static') continue;
    out.push({ id: entry.id, collider });
  }
  return out;
}

/**
 * The default reader: `fetch`, which is what a page has.
 *
 * @param url The resolved `src`.
 * @returns Its bytes.
 */
const fetchAsset: ReadAsset = async (url) => {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`HTTP ${String(response.status)}`);
  return response.arrayBuffer();
};

/**
 * Add the level to the world: body `firstId + i` for `level[i]`.
 *
 * @param world The room's physics world, made for the guest's bodies plus these.
 * @param manifest The manifest, for resolving `collider.src` against `baseUrl`.
 * @param level The static colliders, from {@link staticColliders}.
 * @param firstId The first host-owned id: the guest's `maxBodies + 1`.
 * @param options How to read a `src` (default `fetch`) and Jolt's wasm location.
 * @returns Resolves once every body is in the world.
 * @throws {Error} Naming the entry, when a collider cannot be read or its shape is not supported.
 */
export async function addLevelColliders(
  world: PhysicsService,
  manifest: AssetManifest,
  level: readonly LevelCollider[],
  firstId: number,
  options: LevelColliderOptions = {},
): Promise<void> {
  for (const [i, { id, collider }] of level.entries()) {
    try {
      await addOne(world, manifest, collider, firstId + i, options);
    } catch (cause) {
      const reason = cause instanceof Error ? cause.message : String(cause);
      throw new Error(`level collider of "${id}" (${collider.shape}${srcOf(collider)}): ${reason}`, { cause });
    }
  }
}

/**
 * @param collider The collider.
 * @returns ` <src>` when it has one, else nothing.
 */
function srcOf(collider: AssetCollider): string {
  return collider.src === undefined ? '' : ` ${collider.src}`;
}

/**
 * Build one static body.
 *
 * @param world The physics world.
 * @param manifest The manifest.
 * @param collider The collider.
 * @param id Its body id.
 * @param options The reader and Jolt's options.
 */
async function addOne(
  world: PhysicsService,
  manifest: AssetManifest,
  collider: AssetCollider,
  id: number,
  options: LevelColliderOptions,
): Promise<void> {
  const [x, y, z] = collider.offset ?? [0, 0, 0];
  const body: BodyArgs = {
    id,
    shape: 'box',
    dims: [],
    position: [x, y, z],
    rotation: [0, 0, 0, 1],
    mass: 0,
    kind: 'static',
    layer: LAYER_STATIC_GEOMETRY,
    mask: 0xffff,
    friction: 0.8,
    restitution: 0,
  };
  if (collider.shape === 'box' && collider.halfExtents !== undefined) {
    world.addBody({ ...body, dims: [...collider.halfExtents] });
    return;
  }
  if (collider.shape === 'sphere' && collider.radius !== undefined) {
    world.addBody({ ...body, shape: 'sphere', dims: [collider.radius] });
    return;
  }
  if (collider.shape !== 'mesh' || collider.src === undefined) {
    throw new Error('a level collider is a mesh with a src, a box or a sphere');
  }
  const read = options.readAsset ?? fetchAsset;
  const mesh = parseCollider(await read(joinUrl(manifest.baseUrl, collider.src)));
  const jolt = await loadJolt({ wasmUrl: options.physics?.wasmUrl });
  const shape = meshShapeFromGeometry(jolt, mesh.positions, mesh.indices);
  try {
    world.addBody({ ...body, shape: 'mesh', geometry: shape });
  } finally {
    shape.Release(); // the world took its own reference
  }
}
