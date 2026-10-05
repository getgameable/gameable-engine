/**
 * The street's shared things, found once in `init` from their tags: six
 * doors (one per house, in house order), the cars and the benches. What
 * they are doing lives here too, in flat lanes. Authority state.
 */
import { query, Transform, type GameContext } from 'gameable';

import { Bench, COLOURS, Car, Door, Home, tint } from './prefabs';
import { BENCH_SPOTS, CAR_SPOTS, HOUSES } from './street';

/** The doors, by house. */
export const doors = {
  entity: new Int32Array(HOUSES),
  /** 1 while open (or opening). */
  open: new Uint8Array(HOUSES),
  /** How far it has slid, metres. */
  slid: new Float64Array(HOUSES),
  /** Where it stands closed. */
  x: new Float32Array(HOUSES),
  y: new Float32Array(HOUSES),
  z: new Float32Array(HOUSES),
};

/** The cars. Their pose is kept here: the authority is what moves them. */
export const cars = {
  entity: new Int32Array(CAR_SPOTS.length),
  x: new Float32Array(CAR_SPOTS.length),
  y: new Float32Array(CAR_SPOTS.length),
  z: new Float32Array(CAR_SPOTS.length),
  /** Radians about +Y; forward is `(-sin, -cos)`. */
  yaw: new Float32Array(CAR_SPOTS.length),
  /** Metres per second along forward; negative reverses. */
  speed: new Float32Array(CAR_SPOTS.length),
  /** The seat driving it, `-1` for parked. */
  driver: new Int8Array(CAR_SPOTS.length),
};

/** The benches. */
export const benches = new Int32Array(BENCH_SPOTS.length);

const DOOR_TERMS = [Door, Transform];
const CAR_TERMS = [Car, Transform];
const BENCH_TERMS = [Bench, Transform];
const HOME_TERMS = [Home, Transform];

/**
 * @param qy A rotation about +Y only: its quaternion's y.
 * @param qw Its w.
 * @returns The yaw, radians.
 */
function yawOf(qy: number, qw: number): number {
  return 2 * Math.atan2(qy, qw);
}

/**
 * Find and paint every prop. Call from `init`, after the declarative spawns.
 *
 * @param ctx The init context.
 */
export function findProps(ctx: GameContext): void {
  for (const e of query(ctx.world, HOME_TERMS)) {
    tint(e, COLOURS.house[0], COLOURS.house[1], COLOURS.house[2]);
  }
  const d = query(ctx.world, DOOR_TERMS);
  for (let i = 0; i < HOUSES; i += 1) {
    const e = d[i] ?? 0;
    doors.entity[i] = e;
    doors.open[i] = 0;
    doors.slid[i] = 0;
    doors.x[i] = Transform.x[e] ?? 0;
    doors.y[i] = Transform.y[e] ?? 0;
    doors.z[i] = Transform.z[e] ?? 0;
    if (e !== 0) tint(e, COLOURS.door[0], COLOURS.door[1], COLOURS.door[2]);
  }
  const c = query(ctx.world, CAR_TERMS);
  for (let i = 0; i < CAR_SPOTS.length; i += 1) {
    const e = c[i] ?? 0;
    cars.entity[i] = e;
    cars.x[i] = Transform.x[e] ?? 0;
    cars.y[i] = Transform.y[e] ?? 0;
    cars.z[i] = Transform.z[e] ?? 0;
    cars.yaw[i] = yawOf(Transform.qy[e] ?? 0, Transform.qw[e] ?? 1);
    cars.speed[i] = 0;
    cars.driver[i] = -1;
    if (e !== 0) tint(e, COLOURS.car[0], COLOURS.car[1], COLOURS.car[2]);
  }
  const b = query(ctx.world, BENCH_TERMS);
  for (let i = 0; i < BENCH_SPOTS.length; i += 1) {
    benches[i] = b[i] ?? 0;
    if (benches[i] !== 0) tint(benches[i], COLOURS.bench[0], COLOURS.bench[1], COLOURS.bench[2]);
  }
}

/**
 * @param entity A body.
 * @param x World x.
 * @param z World z.
 * @returns The squared planar distance from the body to the point.
 */
export function distanceSq(entity: number, x: number, z: number): number {
  const dx = (Transform.x[entity] ?? 0) - x;
  const dz = (Transform.z[entity] ?? 0) - z;
  return dx * dx + dz * dz;
}
