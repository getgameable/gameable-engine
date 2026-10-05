/**
 * Where things stand in the placeholder arena: one base per seat on a ring
 * round the middle, and the conveyor straight through it along X.
 *
 * Metres, Y-up, origin at the centre of the floor (the arena is 12 m from the
 * centre to a wall).
 */
import { BRAINROT_HALF, THIEF_CENTRE } from './prefabs';

/** Seats in a room, and so bases on the ring: `features.multiplayer.maxPlayers`. */
export const MAX_PLAYERS = 6;
/** How far the bases stand from the middle. */
export const RING_RADIUS = 8.5;
/** Where the conveyor starts and ends on X; brainrots ride from start to end. */
export const BELT_START = -5;
export const BELT_END = 5;
/** Height a brainrot rides at: resting on the belt. */
export const BRAINROT_Y = 0.1 + BRAINROT_HALF[1];

/** Each seat's base centre, on the floor: seat `i` owns `BASES[i]`. */
export const BASES: readonly { x: number; z: number }[] = Array.from(
  { length: MAX_PLAYERS },
  (_, i) => {
    // Angle 0 is +Z; with six seats none sits on the belt's line (along X).
    const angle = (i / MAX_PLAYERS) * Math.PI * 2;
    return { x: Math.sin(angle) * RING_RADIUS, z: Math.cos(angle) * RING_RADIUS };
  },
);

/** Where each seat spawns: standing in their own base (`player.spawn`, seat `i` takes `[i]`). */
export const SPAWNS: [number, number, number][] = BASES.map((b) => [b.x, THIEF_CENTRE, b.z]);

/**
 * @param seat A seat.
 * @param x A point's x.
 * @param z A point's z.
 * @param radius How close counts as "in", metres.
 * @returns True when the point is inside that seat's base.
 */
export function inBase(seat: number, x: number, z: number, radius: number): boolean {
  const base = BASES[seat];
  return Math.abs(x - base.x) <= radius && Math.abs(z - base.z) <= radius;
}
