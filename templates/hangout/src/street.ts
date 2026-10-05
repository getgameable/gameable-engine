/**
 * Where everything stands on the street, in metres, Y-up, origin at the
 * centre of the placeholder arena's floor (12 m half-width).
 *
 * The street runs along X. Three houses face it from the north (`z < 0`) and
 * three from the south; two cars are parked on it and two benches sit between
 * the houses. Player `n` lives in house `n % 6` and spawns at its door, so
 * twelve players are two to a house.
 */

/** How many houses the street has. */
export const HOUSES = 6;

/** House half extents: a placeholder box. */
export const HOUSE_HALF: readonly [number, number, number] = [1.6, 1.5, 1.6];
/** Door half extents: a slab on the house's street side. */
export const DOOR_HALF: readonly [number, number, number] = [0.6, 1.1, 0.1];
/** Car half extents, long along its own Z. */
export const CAR_HALF: readonly [number, number, number] = [0.9, 0.55, 1.9];
/** Bench half extents. */
export const BENCH_HALF: readonly [number, number, number] = [0.8, 0.25, 0.3];

/** Height of a resident's body centre when standing on the floor. */
export const RESIDENT_CENTRE = 1.15;

/** A house's centre on the floor plan. */
export interface Lot {
  x: number;
  z: number;
  /** +1 for a house on the north side (its door faces +Z), -1 for the south. */
  faces: number;
}

/** The six lots, house 0 to 5: north row west to east, then south row. */
export const LOTS: readonly Lot[] = [
  { x: -7, z: -7, faces: 1 },
  { x: 0, z: -7, faces: 1 },
  { x: 7, z: -7, faces: 1 },
  { x: -7, z: 7, faces: -1 },
  { x: 0, z: 7, faces: -1 },
  { x: 7, z: 7, faces: -1 },
];

/** Where the cars are parked: on the street, facing west (yaw PI/2). */
export const CAR_SPOTS: readonly (readonly [number, number])[] = [
  [-4, 0],
  [4, 0],
];

/** Where the benches are: in the gaps between houses. */
export const BENCH_SPOTS: readonly (readonly [number, number])[] = [
  [-3.5, -4.6],
  [3.5, 4.6],
];

/** How far from the centre a car may drive, X and Z: the street, between the doors. */
export const STREET_BOUNDS: readonly [number, number] = [10, 3];

/**
 * @param seat A player id.
 * @returns The house that player lives in.
 */
export function houseOf(seat: number): number {
  return seat % HOUSES;
}

/**
 * @param house A house index.
 * @returns Where its door's centre is on the floor plan.
 */
export function doorAt(house: number): [number, number] {
  const lot = LOTS[house];
  return [lot.x, lot.z + lot.faces * (HOUSE_HALF[2] + DOOR_HALF[2] + 0.02)];
}

/**
 * Every seat's spawn point: in front of their own door, the first six on the
 * left of it, the next six on the right.
 *
 * @param seats How many seats.
 * @returns `[x, y, z]` per seat, for `player.spawn`.
 */
export function spawnPoints(seats: number): number[][] {
  const out: number[][] = [];
  for (let seat = 0; seat < seats; seat += 1) {
    const lot = LOTS[houseOf(seat)];
    const side = seat < HOUSES ? -0.8 : 0.8;
    out.push([lot.x + side, RESIDENT_CENTRE, lot.z + lot.faces * 3.2]);
  }
  return out;
}

/**
 * @param yaw Radians about +Y.
 * @returns The quaternion `[x, y, z, w]`.
 */
export function yawQuat(yaw: number): [number, number, number, number] {
  return [0, Math.sin(yaw * 0.5), 0, Math.cos(yaw * 0.5)];
}
