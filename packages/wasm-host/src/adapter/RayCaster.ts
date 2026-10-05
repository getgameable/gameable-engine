/**
 * One raycast, retried past excluded bodies, into one reused hit record.
 */
import type { PhysicsService } from '@gameable/physics-jolt';
import type { QueryFilter, RayHit, Vec3 } from '@gameable/sdk';

import { layerBits } from './bodyShapes';

/**
 * How many times a raycast is re-cast past an excluded body before giving up.
 *
 * Jolt's closest-hit collector has no notion of "skip this entity", so the
 * ray is restarted a hair past the unwanted hit. Two retries covers a
 * character standing inside its own capsule and touching one other excluded
 * body; more than that and the game should be using a layer mask.
 */
const EXCLUDE_RETRIES = 3;

/** Metres the ray is nudged past an excluded hit before being re-cast. */
const EXCLUDE_EPSILON = 1e-3;

/**
 * Allocate one zeroed `ray-hit`, for the query pools.
 *
 * @returns A fresh record.
 */
export function newRayHit(): RayHit {
  return {
    body: 0,
    entity: 0,
    point: { x: 0, y: 0, z: 0 },
    normal: { x: 0, y: 0, z: 0 },
    distance: 0,
  };
}

/** Casts rays with the exclude-retry rule, reporting entities through a body map. */
export class RayCaster {
  /** Reused hit record: the guest copies what it needs before returning. */
  private readonly hit: RayHit = newRayHit();
  /** Origin and direction handed to the physics module, reused every cast. */
  private readonly castOrigin: [number, number, number] = [0, 0, 0];
  private readonly castDirection: [number, number, number] = [0, 0, 0];

  /**
   * @param entityOfBody The body-to-entity map hits report through.
   */
  constructor(private readonly entityOfBody: (body: number) => number) {}

  /**
   * Cast one ray, retrying past an excluded entity.
   *
   * @param live The physics world to cast into.
   * @param origin World-space origin.
   * @param direction Direction; need not be normalised.
   * @param maxDistance Metres.
   * @param filter Layers and exclusions.
   * @returns The reused hit record, or null on a miss.
   */
  cast(
    live: PhysicsService,
    origin: Vec3,
    direction: Vec3,
    maxDistance: number,
    filter: QueryFilter,
  ): RayHit | null {
    const mask = layerBits(filter.layers);
    const length = Math.hypot(direction.x, direction.y, direction.z) || 1;
    const dx = direction.x / length;
    const dy = direction.y / length;
    const dz = direction.z / length;
    const castOrigin = this.castOrigin;
    const castDirection = this.castDirection;
    const hit = this.hit;

    let ox = origin.x;
    let oy = origin.y;
    let oz = origin.z;
    let travelled = 0;

    for (let attempt = 0; attempt <= EXCLUDE_RETRIES; attempt += 1) {
      const remaining = maxDistance - travelled;
      if (remaining <= 0) return null;
      castOrigin[0] = ox;
      castOrigin[1] = oy;
      castOrigin[2] = oz;
      castDirection[0] = dx;
      castDirection[1] = dy;
      castDirection[2] = dz;
      const found = live.raycast(castOrigin, castDirection, remaining, mask);
      if (found === null) return null;
      const entity = this.entityOfBody(found.body);
      const excluded =
        (filter.excludeBody !== undefined && filter.excludeBody === found.body) ||
        (filter.excludeEntity !== undefined &&
          filter.excludeEntity !== 0 &&
          filter.excludeEntity === entity);
      if (!excluded) {
        hit.body = found.body;
        hit.entity = entity;
        hit.point.x = found.px;
        hit.point.y = found.py;
        hit.point.z = found.pz;
        hit.normal.x = found.nx;
        hit.normal.y = found.ny;
        hit.normal.z = found.nz;
        hit.distance = travelled + found.distance;
        return hit;
      }
      const step = found.distance + EXCLUDE_EPSILON;
      travelled += step;
      ox += dx * step;
      oy += dy * step;
      oz += dz * step;
    }
    return null;
  }
}
