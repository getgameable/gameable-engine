/**
 * Physics: synchronous queries and deferred body commands.
 *
 * `raycast`, `raycastBatch` and `overlapSphere` are the only blocking host
 * calls a guest may make during `tick` — each is a full canonical-ABI round
 * trip, so keep them rare and prefer the batch form. Everything else
 * (`moveCharacter`, `applyImpulse`, `setVelocity`) is a command applied after
 * the guest returns.
 */
import { RigidBody } from './ecs';
import { requireRuntime } from './state';
import type { CollisionLayers, OverlapHit, QueryFilter, RayHit, Vec3 } from './types';

/** Every layer, the default filter for a query with no mask. */
const ALL_LAYERS: CollisionLayers = Object.freeze({
  defaultLayer: true,
  staticGeometry: true,
  player: true,
  enemy: true,
  projectile: true,
  pickup: true,
  trigger: true,
  character: true,
  debris: true,
  water: true,
  user0: true,
  user1: true,
  user2: true,
  user3: true,
  user4: true,
  user5: true,
});

/** Reused filter, so a query per frame does not allocate one. */
const filterScratch: QueryFilter = {
  layers: ALL_LAYERS,
  excludeBody: undefined,
  excludeEntity: undefined,
  solidOnly: true,
};

/**
 * Prepare the shared filter.
 *
 * @param mask Layers to consider, or `undefined` for all of them.
 * @param excludeEntity Entity to ignore, usually the caster.
 * @returns The reused filter object.
 */
function filter(mask: CollisionLayers | undefined, excludeEntity: number | undefined): QueryFilter {
  filterScratch.layers = mask ?? ALL_LAYERS;
  filterScratch.excludeEntity = excludeEntity === 0 ? undefined : excludeEntity;
  filterScratch.excludeBody = undefined;
  filterScratch.solidOnly = true;
  return filterScratch;
}

/**
 * Physics queries and body commands.
 *
 * @example
 * ```ts
 * import { physics, Transform } from 'gameable';
 *
 * const hit = physics.raycast(eye, forward, 100);
 * if (hit) console.log('hit entity', hit.entity, 'at', hit.distance);
 * ```
 */
export const physics = {
  /**
   * Actual walkable ground contact from the last host physics step. No host call.
   * Unknown, steep and unsupported contacts return false, even at a jump apex.
   *
   * @param entity Character entity.
   * @returns Whether the character is supported by walkable ground.
   */
  isGrounded(entity: number): boolean {
    return (RigidBody.handle[entity] ?? 0) !== 0 && RigidBody.groundState[entity] === 1;
  },
  /**
   * Closest hit along a ray.
   *
   * @param origin World-space ray origin.
   * @param direction Ray direction; need not be normalised.
   * @param maxDistance Maximum distance in metres.
   * @param mask Layers to consider; defaults to every layer.
   * @param ignoreEntity Entity to skip, usually the caster.
   * @returns The hit, or `null` on a miss. The hit object comes from the host
   *   and is freshly allocated: this call is not allocation-free.
   */
  raycast(
    origin: Vec3,
    direction: Vec3,
    maxDistance: number,
    mask?: CollisionLayers,
    ignoreEntity?: number,
  ): RayHit | null {
    const rt = requireRuntime();
    const hit = rt.host.raycast(origin, direction, maxDistance, filter(mask, ignoreEntity));
    return hit ?? null;
  },

  /**
   * Many rays in one round trip. Result index `i` matches `rays[i]`.
   *
   * @param rays The rays. Build them once and mutate them in place.
   * @returns One result per ray; `undefined` or `null` entries are misses.
   */
  raycastBatch(
    rays: readonly { origin: Vec3; direction: Vec3; maxDistance: number; filter: QueryFilter }[],
  ): readonly (RayHit | undefined | null)[] {
    return requireRuntime().host.raycastBatch(rays);
  },

  /**
   * Bodies overlapping a sphere, nearest first.
   *
   * @param center Sphere centre.
   * @param radius Sphere radius in metres.
   * @param maxResults Cap on returned hits.
   * @param mask Layers to consider; defaults to every layer.
   * @param ignoreEntity Entity to skip.
   * @returns The overlapping bodies.
   */
  overlapSphere(
    center: Vec3,
    radius: number,
    maxResults = 16,
    mask?: CollisionLayers,
    ignoreEntity?: number,
  ): readonly OverlapHit[] {
    const rt = requireRuntime();
    return rt.host.overlapSphere(center, radius, filter(mask, ignoreEntity), maxResults);
  },

  /**
   * Drive a character body for this step.
   *
   * @param entity Entity whose body was created with `kind: 'character'`.
   * @param vx Desired world-space velocity x, metres per second.
   * @param vy Desired world-space velocity y.
   * @param vz Desired world-space velocity z.
   * @param jump Request a jump this step.
   * @param crouch Request a crouch this step.
   * @param maxSlopeDeg Maximum walkable slope.
   * @returns Nothing.
   */
  moveCharacter(
    entity: number,
    vx: number,
    vy: number,
    vz: number,
    jump = false,
    crouch = false,
    maxSlopeDeg = 45,
  ): void {
    const rt = requireRuntime();
    const body = RigidBody.handle[entity] ?? 0;
    if (body === 0) return;
    rt.commands.moveCharacter(body, vx, vy, vz, jump, crouch, maxSlopeDeg);
  },

  /**
   * Apply a one-shot impulse.
   *
   * With no application point the impulse acts at the centre of mass. Give one
   * — all three coordinates — to apply it off-centre and impart spin.
   *
   * @param entity Entity with a body.
   * @param x Impulse x, newton-seconds.
   * @param y Impulse y.
   * @param z Impulse z.
   * @param atX World-space application point x, or omit for the centre of mass.
   * @param atY Application point y.
   * @param atZ Application point z.
   * @returns Nothing.
   */
  applyImpulse(
    entity: number,
    x: number,
    y: number,
    z: number,
    atX?: number,
    atY?: number,
    atZ?: number,
  ): void {
    const rt = requireRuntime();
    const body = RigidBody.handle[entity] ?? 0;
    if (body === 0) return;
    rt.commands.applyImpulse(body, x, y, z, atX, atY, atZ);
  },

  /**
   * Overwrite a body's velocity.
   *
   * Angular velocity is left alone unless all three angular components are
   * given.
   *
   * @param entity Entity with a body.
   * @param x Linear velocity x.
   * @param y Linear velocity y.
   * @param z Linear velocity z.
   * @param ax Angular velocity x, radians per second.
   * @param ay Angular velocity y.
   * @param az Angular velocity z.
   * @returns Nothing.
   */
  setVelocity(
    entity: number,
    x: number,
    y: number,
    z: number,
    ax?: number,
    ay?: number,
    az?: number,
  ): void {
    const rt = requireRuntime();
    const body = RigidBody.handle[entity] ?? 0;
    if (body === 0) return;
    rt.commands.setBodyVelocity(body, x, y, z, ax, ay, az);
  },

  /**
   * Teleport a body, clearing its velocities.
   *
   * @param entity Entity with a body.
   * @param x Position x.
   * @param y Position y.
   * @param z Position z.
   * @returns Nothing.
   */
  teleport(entity: number, x: number, y: number, z: number): void {
    const rt = requireRuntime();
    const body = RigidBody.handle[entity] ?? 0;
    if (body === 0) return;
    rt.commands.setBodyTransform(body, x, y, z, 0, 0, 0, 1, true);
  },

  /**
   * Enable or disable a body in the broad phase.
   *
   * @param entity Entity with a body.
   * @param enabled Whether the body participates.
   * @returns Nothing.
   */
  setEnabled(entity: number, enabled: boolean): void {
    const rt = requireRuntime();
    const body = RigidBody.handle[entity] ?? 0;
    if (body === 0) return;
    rt.commands.setBodyEnabled(body, enabled);
  },

  /** Every collision layer, for queries that should hit anything. */
  ALL_LAYERS,
};
