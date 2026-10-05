/**
 * Where things stand in the placeholder arena: the camp in the middle, a ring
 * of trees around it, and the tree line beyond them where creatures come from.
 *
 * Metres, Y-up, origin at the centre of the floor (the arena is 12 m from the
 * centre to a wall).
 */
import type { SpawnSpec } from 'gameable';

import { SURVIVOR_CENTRE, TREE_HALF, Tree } from './prefabs';

/** Where every survivor spawns, and gets up at dawn: the camp. */
export const CAMP: readonly [number, number, number] = [0, SURVIVOR_CENTRE, 0];

/** How far the trees stand from the camp, metres. */
export const TREE_RING = 7;
/** How many trees. */
export const TREE_COUNT = 6;
/** How far from the camp creatures appear: the tree line, behind the trees. */
export const TREE_LINE = 10;

/**
 * Point `angle` on a circle of `radius` round the camp, written into `out`.
 * Allocates nothing.
 *
 * @param angle Radians; 0 is +Z.
 * @param radius Metres.
 * @param out Where the point goes (`y` is left alone).
 * @returns `out`.
 */
export function onCircle<T extends { x: number; z: number }>(
  angle: number,
  radius: number,
  out: T,
): T {
  out.x = Math.sin(angle) * radius;
  out.z = Math.cos(angle) * radius;
  return out;
}

/** The trees, as the declarative `spawns` list. Built once, at module scope. */
export const TREES: SpawnSpec[] = Array.from({ length: TREE_COUNT }, (_, i) => {
  const p = onCircle((i / TREE_COUNT) * Math.PI * 2, TREE_RING, { x: 0, z: 0 });
  return { prefab: Tree, position: [p.x, TREE_HALF[1], p.z] };
});
