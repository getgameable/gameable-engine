/**
 * Where people stand in the placeholder arena.
 *
 * Metres, Y-up, origin at the centre of the floor. Every player spawns at the
 * declared `player.spawn`; when the host starts a round, everyone is moved to
 * a seat on this ring so nobody starts touching "it".
 */

/** Radius of the starting ring, metres. Inside the arena's 12 m half-width. */
export const RING_RADIUS = 5;

/** Height of a body's centre at the ring, metres. */
export const RING_HEIGHT = 1.2;

/**
 * Seat `i` of `n` on the ring, written into `out`. Allocates nothing.
 *
 * @param i The seat index, `0..n`.
 * @param n How many seats there are.
 * @param out Where the position goes.
 * @returns `out`.
 */
export function seat(
  i: number,
  n: number,
  out: { x: number; y: number; z: number },
): { x: number; y: number; z: number } {
  const angle = (i / Math.max(1, n)) * Math.PI * 2;
  out.x = Math.sin(angle) * RING_RADIUS;
  out.y = RING_HEIGHT;
  out.z = Math.cos(angle) * RING_RADIUS;
  return out;
}
