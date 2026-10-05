/**
 * Prefabs: a declarative description of "what an entity is", and the one
 * function that turns it into an entity plus the commands the host needs.
 *
 * `prefab()` is pure and safe at module scope — it resolves nothing, so the
 * Wizer snapshot captures no host state. Everything is resolved on the first
 * `spawn()`, inside `init` or a system.
 */
import { assetId } from './assets';
import { allocateBody, releaseBody } from './bodyIds';
import {
  addComponent,
  Character,
  Health,
  RigidBody,
  Renderable,
  Transform,
  Velocity,
  addEntity,
  removeEntity,
  BODY_KINDS,
  SHAPE_KINDS,
} from './ecs';
import { TRANSFORM_ALL, TRANSFORM_FLAGS } from './packing';
import { requireRuntime } from './state';
import type { BodyFlags, BodyKind, CollisionLayers, Quat, ShapeKind, Vec3 } from './types';

/** The physics body a prefab carries. */
export interface BodySpec {
  /** Collision shape family. */
  shape: ShapeKind;
  /**
   * Shape dimensions. `box`: half extents. `sphere`: `[radius]`.
   * `capsule` / `cylinder`: `[radius, halfHeight]`. `plane`: the normal.
   */
  dims?: readonly number[];
  /** Body class. `'character'` makes a `CharacterVirtual` controller. */
  kind: BodyKind;
  /** Kilograms; ignored for fixed and kinematic bodies. Default 1. */
  mass?: number;
  /** What this body is. Default `{ defaultLayer: true }`. */
  layer?: CollisionLayers;
  /** What this body collides with. Default every layer. */
  mask?: CollisionLayers;
  /** Per-body switches. */
  flags?: BodyFlags;
  /** Coulomb friction. Default 0.5. */
  friction?: number;
  /** Bounciness in 0..1. Default 0. */
  restitution?: number;
}

/** Everything a prefab can declare. */
export interface PrefabSpec {
  /** Renderable asset: a manifest string id, or a handle. */
  asset?: string | number;
  /** Debug label shown in the engine overlay. */
  name?: string;
  /** Physics body, if any. */
  body?: BodySpec;
  /** Splat character bundle: a manifest string id, or a handle. */
  character?: string | number;
  /** Uniform or per-axis scale. Default `[1, 1, 1]`. */
  scale?: readonly number[];
  /** Starting hit points; adds the `Health` component when present. */
  health?: number;
  /** Extra bitecs components and tags to add on spawn. */
  components?: readonly object[];
}

/** A prefab, ready to `spawn`. */
export interface PrefabDef extends PrefabSpec {
  /** Stable index, assigned in declaration order. */
  readonly prefabId: number;
}

/** Round to f32: every float in the WIT contract is an `f32`. */
const f = Math.fround;

let nextPrefabId = 1;

/** Every prefab declared so far, indexed by `prefabId`. */
const registry: PrefabDef[] = [];

/** Identity rotation, reused so `spawn` without a rotation allocates nothing. */
const IDENTITY: Quat = Object.freeze({ x: 0, y: 0, z: 0, w: 1 });

/**
 * Every WIT `collision-layers` member, in declaration order.
 *
 * Bit `i` of the physics module's numeric layer/mask is member `i` of this
 * list. It is a contract between the guest, which writes the flags record, and
 * the host, which folds it into a bitmask — so both sides import this one
 * list rather than keeping a copy each.
 *
 * @example
 * ```ts
 * import { LAYER_KEYS } from 'gameable';
 *
 * const bit = LAYER_KEYS.indexOf('enemy'); // 3
 * ```
 */
export const LAYER_KEYS = [
  'defaultLayer',
  'staticGeometry',
  'player',
  'enemy',
  'projectile',
  'pickup',
  'trigger',
  'character',
  'debris',
  'water',
  'user0',
  'user1',
  'user2',
  'user3',
  'user4',
  'user5',
] as const satisfies readonly (keyof CollisionLayers)[];

/** Every `body-flags` key, in WIT declaration order. */
const BODY_FLAG_KEYS = [
  'reportContacts',
  'sensor',
  'noSleep',
  'lockRotation',
  'ccd',
  'debugDraw',
] as const;

/** A WIT `flags` record as a plain lookup. */
type FlagRecord = Record<string, boolean | undefined>;

/**
 * Expand a sparse flags object into one with every key present.
 *
 * jco hands the host a flags record with every member set, so a guest that
 * emits `{ player: true }` would look different in direct mode than in wasm
 * mode. Expanding here keeps the two byte-identical.
 *
 * @param keys Every key the flags record declares.
 * @param value The sparse object the game wrote.
 * @returns A frozen object with every key present.
 */
function completeFlags<K extends string>(
  keys: readonly K[],
  value: FlagRecord | undefined,
): Record<K, boolean> {
  const out = {} as Record<K, boolean>;
  for (const key of keys) out[key] = value?.[key] === true;
  return out;
}

/** Cache of expanded flag records, keyed by the object the game wrote. */
const flagCache = new WeakMap<object, Record<string, boolean>>();

/**
 * Expand and memoise a flags record.
 *
 * @param keys Every key the record declares.
 * @param value The sparse object, or undefined.
 * @param fallback Used when `value` is undefined.
 * @returns The expanded record.
 */
function flagsOf<K extends string>(
  keys: readonly K[],
  value: FlagRecord | undefined,
  fallback: FlagRecord,
): Record<K, boolean> {
  const source = value ?? fallback;
  const cached = flagCache.get(source);
  if (cached) return cached;
  const expanded = completeFlags(keys, source);
  flagCache.set(source, expanded);
  return expanded;
}

const DEFAULT_LAYER: CollisionLayers = Object.freeze({ defaultLayer: true });
const DEFAULT_MASK: CollisionLayers = Object.freeze({
  defaultLayer: true,
  staticGeometry: true,
  player: true,
  enemy: true,
  projectile: true,
  pickup: true,
  trigger: true,
  character: true,
  debris: true,
});
const NO_FLAGS: BodyFlags = Object.freeze({});

/**
 * Declare a prefab.
 *
 * Safe at module scope: nothing is resolved until the first `spawn`.
 *
 * @param spec What the entity is made of.
 * @returns The prefab, ready to `spawn`.
 *
 * @example
 * ```ts
 * import { prefab } from 'gameable';
 *
 * export const Crate = prefab({
 *   asset: 'crate',
 *   body: { shape: 'box', dims: [0.5, 0.5, 0.5], kind: 'dynamic', mass: 20 },
 * });
 * ```
 */
export function prefab(spec: PrefabSpec): PrefabDef {
  const def: PrefabDef = { ...spec, prefabId: nextPrefabId };
  nextPrefabId += 1;
  registry.push(def);
  return def;
}

/**
 * Every prefab declared so far, in declaration order.
 *
 * @returns The registry, for tooling and tests.
 */
export function prefabRegistry(): readonly PrefabDef[] {
  return registry;
}

/**
 * Instantiate a prefab.
 *
 * Mints the entity id, writes the built-in components and queues the
 * `spawn` / `add-body` / `spawn-character` commands the host needs.
 *
 * @param def A prefab from `prefab()`.
 * @param position World position.
 * @param rotation World rotation, xyzw. Defaults to identity.
 * @returns The new entity id.
 *
 * @example
 * ```ts
 * import { spawn } from 'gameable';
 *
 * const crate = spawn(Crate, { x: 0, y: 2, z: -5 });
 * ```
 */
export function spawn(def: PrefabDef, position: Vec3, rotation: Quat = IDENTITY): number {
  const rt = requireRuntime();
  const entity = addEntity(rt.world);

  const sx = def.scale?.[0] ?? 1;
  const sy = def.scale?.[1] ?? sx;
  const sz = def.scale?.[2] ?? sx;

  addComponent(rt.world, entity, Transform);
  Transform.x[entity] = position.x;
  Transform.y[entity] = position.y;
  Transform.z[entity] = position.z;
  Transform.qx[entity] = rotation.x;
  Transform.qy[entity] = rotation.y;
  Transform.qz[entity] = rotation.z;
  Transform.qw[entity] = rotation.w;
  Transform.sx[entity] = sx;
  Transform.sy[entity] = sy;
  Transform.sz[entity] = sz;

  const asset =
    def.asset === undefined ? 0 : typeof def.asset === 'string' ? assetId(def.asset) : def.asset;
  if (asset !== 0) {
    addComponent(rt.world, entity, Renderable);
    Renderable.asset[entity] = asset;
    Renderable.flags[entity] = 0;
    Renderable.dirty[entity] = 0;
  }

  rt.commands.spawn(
    entity,
    asset === 0 ? undefined : asset,
    position.x,
    position.y,
    position.z,
    rotation.x,
    rotation.y,
    rotation.z,
    rotation.w,
    sx,
    sy,
    sz,
    def.name,
  );

  const body = def.body;
  if (body) {
    const handle = allocateBody(rt); // the lowest freed id first: ids stay under the live count
    addComponent(rt.world, entity, RigidBody);
    RigidBody.handle[entity] = handle;
    RigidBody.kind[entity] = Math.max(0, BODY_KINDS.indexOf(body.kind));
    RigidBody.shape[entity] = Math.max(0, SHAPE_KINDS.indexOf(body.shape));
    RigidBody.dirty[entity] = 0;
    rt.bodyIndex.bind(handle, entity);
    addComponent(rt.world, entity, Velocity);
    const cmd = rt.commands.addBody(
      handle,
      entity,
      body.kind,
      body.shape,
      body.dims?.[0] ?? 0.5,
      body.dims?.[1] ?? 0.5,
      body.dims?.[2] ?? 0.5,
      position.x,
      position.y,
      position.z,
      body.mass ?? 1,
      flagsOf(LAYER_KEYS, body.layer as FlagRecord | undefined, DEFAULT_LAYER as FlagRecord),
      flagsOf(LAYER_KEYS, body.mask as FlagRecord | undefined, DEFAULT_MASK as FlagRecord),
      flagsOf(BODY_FLAG_KEYS, body.flags as FlagRecord | undefined, NO_FLAGS as FlagRecord),
    );
    // `addBody` wrote the rounded defaults; anything overwritten here has to
    // be rounded too, or direct mode drifts from wasm mode by an f64 tail.
    cmd.rotation.x = f(rotation.x);
    cmd.rotation.y = f(rotation.y);
    cmd.rotation.z = f(rotation.z);
    cmd.rotation.w = f(rotation.w);
    cmd.friction = f(body.friction ?? 0.5);
    cmd.restitution = f(body.restitution ?? 0);
  }

  if (def.character !== undefined) {
    const bundle = typeof def.character === 'string' ? assetId(def.character) : def.character;
    if (bundle !== 0) {
      addComponent(rt.world, entity, Character);
      Character.bundle[entity] = bundle;
      Character.dirty[entity] = 0;
      rt.commands.spawnCharacter(
        entity,
        bundle,
        position.x,
        position.y,
        position.z,
        rotation.x,
        rotation.y,
        rotation.z,
        rotation.w,
      );
    }
  }

  if (def.health !== undefined) {
    addComponent(rt.world, entity, Health);
    Health.current[entity] = def.health;
    Health.max[entity] = def.health;
  }

  if (def.components) {
    for (const component of def.components) addComponent(rt.world, entity, component);
  }

  rt.packer.mark(entity, TRANSFORM_ALL | TRANSFORM_FLAGS.VISIBLE);
  return entity;
}

/**
 * Destroy an entity, its body and its host-side representation.
 *
 * @param entity The entity id.
 * @returns Nothing.
 *
 * @example
 * ```ts
 * import { despawn } from 'gameable';
 *
 * despawn(enemy);
 * ```
 */
export function despawn(entity: number): void {
  const rt = requireRuntime();
  const body = RigidBody.handle[entity] ?? 0;
  if (body !== 0) {
    rt.commands.removeBody(body);
    releaseBody(rt, body); // before unbind: see releaseBody
    rt.bodyIndex.unbind(body);
    RigidBody.handle[entity] = 0;
  }
  rt.commands.despawn(entity);
  rt.players.forgetEntity(entity);
  rt.packer.dirty[entity] = 0;
  removeEntity(rt.world, entity);
}

/**
 * Reset prefab numbering. Tests only — a game never calls this.
 *
 * @returns Nothing.
 */
export function resetPrefabRegistry(): void {
  registry.length = 0;
  nextPrefabId = 1;
}
