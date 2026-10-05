/**
 * Where things stand in the placeholder arena: everyone spawns in the middle,
 * and coins lie anywhere within `COIN_RADIUS` of it.
 *
 * Metres, Y-up, origin at the centre of the floor (the arena is 12 m from the
 * centre to a wall).
 */
import type { Rng } from 'gameable';

import { BODY_CENTRE } from './prefabs';

/** Where every collector spawns. */
export const SPAWN: readonly [number, number, number] = [0, BODY_CENTRE, 0];

/** How far from the middle a coin may lie, metres. */
export const COIN_RADIUS = 10;

/**
 * A random spot on the floor for a coin, uniform over the disc. Allocates nothing.
 *
 * @param rng The authority's random source.
 * @param out Where the point goes.
 * @returns `out`.
 */
export function coinSpot<T extends { x: number; z: number }>(rng: Rng, out: T): T {
  const angle = rng.float() * Math.PI * 2;
  const radius = Math.sqrt(rng.float()) * COIN_RADIUS;
  out.x = Math.sin(angle) * radius;
  out.z = Math.cos(angle) * radius;
  return out;
}
