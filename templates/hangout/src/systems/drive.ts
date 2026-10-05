/**
 * Cars and seats, on the authority, after `walk`.
 *
 * A driven car is a kinematic body moved by its driver's own keys: W and S
 * are throttle and brake (reverse once stopped), A and D steer while it
 * rolls. The authority keeps the car's pose (`props.cars`) and writes it as a
 * non-teleport `set-body-transform`, so pages glide it between rows. The
 * driver's body rides along with it, in the `sit` state, and their
 * camera follows the car. Someone on a bench is also told `sit` here, after
 * the walk controller has said `idle`.
 */
import { activeRuntime, character, RigidBody, type GameContext } from 'gameable';

import { cars } from '../props';
import { MAX_PLAYERS, num, residents } from '../residents';
import { STREET_BOUNDS } from '../street';

/** Reused follow options. */
const follow = { yaw: 0, pitch: 0, distance: 7, height: 1.2 };

/**
 * @param value A number.
 * @param limit Its largest size either way.
 * @returns The number, clamped to `[-limit, limit]`.
 */
function clamp(value: number, limit: number): number {
  return value > limit ? limit : value < -limit ? -limit : value;
}

/**
 * Move a body without a teleport, so pages interpolate it.
 *
 * @param entity The body's entity.
 * @param x World x.
 * @param y World y.
 * @param z World z.
 * @param yaw Radians about +Y.
 */
function place(entity: number, x: number, y: number, z: number, yaw: number): void {
  const body = RigidBody.handle[entity] ?? 0;
  if (body === 0) return;
  const half = yaw * 0.5;
  activeRuntime().commands.setBodyTransform(
    body,
    x,
    y,
    z,
    0,
    Math.sin(half),
    0,
    Math.cos(half),
    false,
  );
}

/**
 * One car, one step, from its driver's keys.
 *
 * @param ctx The frame context.
 * @param seat The driver.
 * @param car The car, by index.
 */
function steer(ctx: GameContext, seat: number, car: number): void {
  const handle = ctx.players.get(seat);
  if (handle === undefined) return;
  const keys = handle.input.axis2('A', 'D', 'S', 'W');
  const top = num(ctx.rules.carSpeed, 9);
  const back = num(ctx.rules.carReverse, 3);
  const accel = num(ctx.rules.carAccel, 6);
  const target = keys.y > 0 ? top * keys.y : keys.y < 0 ? back * keys.y : 0;
  const speed = cars.speed[car];
  const step = accel * ctx.dt;
  cars.speed[car] =
    target > speed ? Math.min(target, speed + step) : Math.max(target, speed - step);
  // Steering bites in proportion to speed, and flips in reverse, as a car's does.
  const turn = num(ctx.rules.carTurnRate, 1.6) * (cars.speed[car] / top);
  cars.yaw[car] -= keys.x * turn * ctx.dt;
  const yaw = cars.yaw[car];
  cars.x[car] = clamp(cars.x[car] - Math.sin(yaw) * cars.speed[car] * ctx.dt, STREET_BOUNDS[0]);
  cars.z[car] = clamp(cars.z[car] - Math.cos(yaw) * cars.speed[car] * ctx.dt, STREET_BOUNDS[1]);
  place(cars.entity[car], cars.x[car], cars.y[car], cars.z[car], yaw);

  const entity = residents.entity[seat];
  place(entity, cars.x[car], cars.y[car] + 1.2, cars.z[car], yaw);
  character.setState(entity, 'sit', 0, 0, 0, true);
  const look = handle.camera.look;
  follow.yaw = look.yaw;
  follow.pitch = look.pitch;
  handle.camera.follow(cars.entity[car], follow);
}

/**
 * The `drive` system.
 *
 * @param ctx The frame context.
 */
export function drive(ctx: GameContext): void {
  for (let seat = 0; seat < MAX_PLAYERS; seat += 1) {
    const entity = residents.entity[seat];
    if (entity === 0) continue;
    const car = residents.car[seat];
    if (car >= 0) steer(ctx, seat, car);
    else if (residents.bench[seat] !== 0) character.setState(entity, 'sit', 0, 0, 0, true);
  }
}
