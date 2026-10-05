/**
 * The ECS: bitecs 0.4 plus the SoA components every gameable game shares.
 *
 * Components are structure-of-arrays: `Transform.x[entity]`, not
 * `Transform[entity].x`. Every array is preallocated to `maxEntities` at
 * configure time, so no system ever allocates while writing one.
 */
import {
  addComponent,
  addEntity,
  createWorld,
  hasComponent,
  query,
  removeComponent,
  removeEntity,
} from 'bitecs';

export { addComponent, addEntity, createWorld, hasComponent, query, removeComponent, removeEntity };
export { And, Not, Or, entityExists, getAllEntities, resetWorld } from 'bitecs';
// `query()` hashes its terms and filters the array on every call, so the hot
// path registers once and reads `Query.dense` instead. `commitRemovals` is the
// deferred-removal flush `query()` would otherwise do for you.
export { commitRemovals, registerQuery } from 'bitecs';
export type { EntityId, Query, World } from 'bitecs';

/** Default entity ceiling. Every built-in component array is this long. */
export const DEFAULT_MAX_ENTITIES = 4096;

let maxEntities = DEFAULT_MAX_ENTITIES;

/**
 * How many entities the built-in component arrays currently hold.
 *
 * @returns The configured entity ceiling.
 */
export function getMaxEntities(): number {
  return maxEntities;
}

/** Position, rotation (xyzw) and scale, one lane per component. */
export interface TransformStore {
  x: Float32Array;
  y: Float32Array;
  z: Float32Array;
  qx: Float32Array;
  qy: Float32Array;
  qz: Float32Array;
  qw: Float32Array;
  sx: Float32Array;
  sy: Float32Array;
  sz: Float32Array;
}

/** Renderable asset handle plus host-side flags. */
export interface RenderableStore {
  /** Manifest asset handle; `0` means "no renderable". */
  asset: Uint32Array;
  /** Reserved host flags bitset. */
  flags: Uint32Array;
  /** Non-zero when the host has not yet seen the current value. */
  dirty: Uint8Array;
}

/** Rigid body handle and classification. */
export interface RigidBodyStore {
  /** Post-step contact: 0 unknown, 1 ground, 2 steep, 3 unsupported, 4 air. */
  groundState: Uint8Array;
  /** Guest-minted body id; `0` means "no body". */
  handle: Uint32Array;
  /** `BODY_KIND` index. */
  kind: Uint8Array;
  /** `SHAPE_KIND` index. */
  shape: Uint8Array;
  /** Non-zero when the host has not yet seen the current value. */
  dirty: Uint8Array;
}

/** Splat character bundle handle. */
export interface CharacterStore {
  /** Character bundle asset handle. */
  bundle: Uint32Array;
  /** Non-zero when the host has not yet seen the current value. */
  dirty: Uint8Array;
}

/** Linear and angular velocity in metres and radians per second. */
export interface VelocityStore {
  x: Float32Array;
  y: Float32Array;
  z: Float32Array;
  ax: Float32Array;
  ay: Float32Array;
  az: Float32Array;
}

/** Current and maximum hit points. */
export interface HealthStore {
  current: Float32Array;
  max: Float32Array;
}

/**
 * Build a fresh SoA store.
 *
 * @param spec Lane name to typed-array constructor.
 * @param n Entity ceiling.
 * @returns An object with one preallocated array per lane.
 */
function makeStore<
  T extends Record<
    string,
    Float32ArrayConstructor | Uint32ArrayConstructor | Uint8ArrayConstructor
  >,
>(spec: T, n: number): Record<keyof T, Float32Array | Uint32Array | Uint8Array> {
  const out = {} as Record<keyof T, Float32Array | Uint32Array | Uint8Array>;
  for (const key of Object.keys(spec) as (keyof T)[]) {
    const Ctor = spec[key];
    out[key] = new Ctor(n);
  }
  return out;
}

const TRANSFORM_SPEC = {
  x: Float32Array,
  y: Float32Array,
  z: Float32Array,
  qx: Float32Array,
  qy: Float32Array,
  qz: Float32Array,
  qw: Float32Array,
  sx: Float32Array,
  sy: Float32Array,
  sz: Float32Array,
} as const;
const RENDERABLE_SPEC = { asset: Uint32Array, flags: Uint32Array, dirty: Uint8Array } as const;
const RIGIDBODY_SPEC = {
  groundState: Uint8Array,
  handle: Uint32Array,
  kind: Uint8Array,
  shape: Uint8Array,
  dirty: Uint8Array,
} as const;
const CHARACTER_SPEC = { bundle: Uint32Array, dirty: Uint8Array } as const;
const VELOCITY_SPEC = {
  x: Float32Array,
  y: Float32Array,
  z: Float32Array,
  ax: Float32Array,
  ay: Float32Array,
  az: Float32Array,
} as const;
const HEALTH_SPEC = { current: Float32Array, max: Float32Array } as const;

/** World transform of an entity. Position, rotation (xyzw), scale. */
export const Transform = makeStore(TRANSFORM_SPEC, maxEntities) as unknown as TransformStore;
/** Renderable asset attached to an entity. */
export const Renderable = makeStore(RENDERABLE_SPEC, maxEntities) as unknown as RenderableStore;
/** Physics body attached to an entity. */
export const RigidBody = makeStore(RIGIDBODY_SPEC, maxEntities) as unknown as RigidBodyStore;
/** Splat character bundle attached to an entity. */
export const Character = makeStore(CHARACTER_SPEC, maxEntities) as unknown as CharacterStore;
/** Guest-integrated velocity, for entities the host physics does not own. */
export const Velocity = makeStore(VELOCITY_SPEC, maxEntities) as unknown as VelocityStore;
/** Hit points. */
export const Health = makeStore(HEALTH_SPEC, maxEntities) as unknown as HealthStore;

/** Tag: the entity the player controls. */
export const Player: Record<string, never> = {};
/** Tag: a hostile entity. */
export const Enemy: Record<string, never> = {};
/** Tag: something the player can pick up. */
export const Pickup: Record<string, never> = {};

/** Every built-in component, in the fixed order `snapshot` serialises them. */
export const BUILTIN_COMPONENTS = [
  Transform,
  Renderable,
  RigidBody,
  Character,
  Velocity,
  Health,
  Player,
  Enemy,
  Pickup,
] as const;

/** Names matching `BUILTIN_COMPONENTS`, used in snapshot headers. */
export const BUILTIN_COMPONENT_NAMES = [
  'Transform',
  'Renderable',
  'RigidBody',
  'Character',
  'Velocity',
  'Health',
  'Player',
  'Enemy',
  'Pickup',
] as const;

const STORES = [
  [Transform, TRANSFORM_SPEC],
  [Renderable, RENDERABLE_SPEC],
  [RigidBody, RIGIDBODY_SPEC],
  [Character, CHARACTER_SPEC],
  [Velocity, VELOCITY_SPEC],
  [Health, HEALTH_SPEC],
] as const;

/**
 * Resize every built-in component array.
 *
 * Call this before `defineGame` runs any system — the runtime calls it from
 * `init` out of `world.maxEntities`. The component objects keep their
 * identity, so bitecs registrations survive; only the arrays inside are
 * replaced, so never cache `Transform.x` across a call.
 *
 * @param n The new entity ceiling. Values below 2 are clamped to 2.
 * @returns Nothing.
 */
export function configureEcs(n: number): void {
  const next = Math.max(2, Math.floor(n));
  if (next === maxEntities) {
    resetBuiltinStores();
    return;
  }
  maxEntities = next;
  for (const [store, spec] of STORES) {
    const target = store as unknown as Record<string, Float32Array | Uint32Array | Uint8Array>;
    const fresh = makeStore(spec, next) as unknown as Record<
      string,
      Float32Array | Uint32Array | Uint8Array
    >;
    for (const key of Object.keys(spec)) target[key] = fresh[key];
  }
}

/**
 * Zero every built-in component array without changing its length.
 *
 * @returns Nothing.
 */
export function resetBuiltinStores(): void {
  for (const [store, spec] of STORES) {
    const target = store as unknown as Record<string, Float32Array | Uint32Array | Uint8Array>;
    for (const key of Object.keys(spec)) target[key].fill(0);
  }
}

/** Physics body classes, in the index order `RigidBody.kind` stores. */
export const BODY_KINDS = ['fixed', 'kinematic', 'dynamic', 'character'] as const;

/** Collision shapes, in the index order `RigidBody.shape` stores. */
export const SHAPE_KINDS = [
  'box',
  'sphere',
  'capsule',
  'cylinder',
  'plane',
  'convex-hull',
  'mesh',
  'height-field',
] as const;
