/**
 * E, on the authority, for each player from their own keys: open or close
 * the nearest front door, get into the nearest free car, or get out of the
 * one you drive. It also works out what each player's prompt says (F at a
 * bench included), for the HUD.
 */
import { Transform, type GameContext } from 'gameable';

import { benches, cars, distanceSq, doors } from '../props';
import {
  MAX_PLAYERS,
  PROMPT_CLOSE,
  PROMPT_DRIVE,
  PROMPT_EXIT,
  PROMPT_NONE,
  PROMPT_OPEN,
  PROMPT_SIT,
  PROMPT_STAND,
  num,
  residents,
} from '../residents';
import { CAR_HALF, RESIDENT_CENTRE } from '../street';

/** The nearest thing of each kind, for one player this tick. */
const near = { door: -1, car: -1, bench: 0, doorD: 0, carD: 0 };

/**
 * Fill `near` for a body.
 *
 * @param ctx The frame context.
 * @param entity The player's body.
 */
function look(ctx: GameContext, entity: number): void {
  const doorR = num(ctx.rules.doorRange, 2);
  const carR = num(ctx.rules.carRange, 2.6);
  const sitR = num(ctx.rules.sitRange, 1.5);
  near.door = -1;
  near.car = -1;
  near.bench = 0;
  near.doorD = doorR * doorR;
  near.carD = carR * carR;
  for (let i = 0; i < doors.entity.length; i += 1) {
    const d = distanceSq(entity, doors.x[i], doors.z[i]);
    if (d > near.doorD) continue;
    near.door = i;
    near.doorD = d;
  }
  for (let i = 0; i < cars.entity.length; i += 1) {
    if (cars.driver[i] >= 0) continue;
    const d = distanceSq(entity, cars.x[i], cars.z[i]);
    if (d > near.carD) continue;
    near.car = i;
    near.carD = d;
  }
  for (let i = 0; i < benches.length; i += 1) {
    const b = benches[i];
    if (b === 0) continue;
    if (distanceSq(entity, Transform.x[b] ?? 0, Transform.z[b] ?? 0) <= sitR * sitR) near.bench = b;
  }
}

/**
 * @param ctx The frame context.
 * @param seat The player getting in.
 * @param car The car, by index.
 */
function getIn(ctx: GameContext, seat: number, car: number): void {
  residents.car[seat] = car;
  cars.driver[car] = seat;
  // The body rides along (`src/systems/drive.ts`) and must not shove the car.
  ctx.physics.setEnabled(residents.entity[seat], false);
}

/**
 * @param ctx The frame context.
 * @param seat The driver.
 */
export function getOut(ctx: GameContext, seat: number): void {
  const car = residents.car[seat];
  if (car < 0) return;
  residents.car[seat] = -1;
  cars.driver[car] = -1;
  cars.speed[car] = 0;
  const entity = residents.entity[seat];
  const yaw = cars.yaw[car];
  const side = CAR_HALF[0] + 0.7;
  ctx.physics.setEnabled(entity, true);
  // Out of the driver's door: the car's right-hand side.
  ctx.physics.teleport(
    entity,
    cars.x[car] + Math.cos(yaw) * side,
    RESIDENT_CENTRE,
    cars.z[car] - Math.sin(yaw) * side,
  );
}

/**
 * One player's tick: their prompt, and what their E does.
 *
 * @param ctx The frame context.
 * @param seat The player.
 * @param pressed True on the tick their E went down.
 */
function act(ctx: GameContext, seat: number, pressed: boolean): void {
  if (residents.car[seat] >= 0) {
    residents.prompt[seat] = PROMPT_EXIT;
    if (pressed) getOut(ctx, seat);
    return;
  }
  if (residents.bench[seat] !== 0) {
    residents.prompt[seat] = PROMPT_STAND;
    return;
  }
  look(ctx, residents.entity[seat]);
  const car = near.car >= 0 && (near.door < 0 || near.carD < near.doorD);
  const door = !car && near.door >= 0;
  let prompt = PROMPT_NONE;
  if (car) prompt = PROMPT_DRIVE;
  else if (door) prompt = doors.open[near.door] === 1 ? PROMPT_CLOSE : PROMPT_OPEN;
  else if (near.bench !== 0) prompt = PROMPT_SIT;
  residents.prompt[seat] = prompt;
  if (!pressed) return;
  if (car) getIn(ctx, seat, near.car);
  else if (door) doors.open[near.door] = doors.open[near.door] === 1 ? 0 : 1;
}

/**
 * The `interact` system.
 *
 * @param ctx The frame context.
 */
export function interact(ctx: GameContext): void {
  for (let seat = 0; seat < MAX_PLAYERS; seat += 1) {
    if (residents.entity[seat] === 0) continue;
    act(ctx, seat, ctx.players.get(seat)?.input.pressed('E') === true);
  }
}

/**
 * The bench in reach of a body, for the `sit` message.
 *
 * @param ctx The frame context.
 * @param entity The body.
 * @returns The bench entity, or 0.
 */
export function benchNear(ctx: GameContext, entity: number): number {
  look(ctx, entity);
  return near.bench;
}
