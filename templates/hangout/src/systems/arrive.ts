/**
 * Moving in and out, on the authority. A seat whose body changed since the
 * last tick has a new resident: they get their house (`house` `{ house }`,
 * to them alone) and a clean slate, in the colour they last wore here when
 * their saved document keeps one. A seat whose body is gone has moved out:
 * the car they drove is parked where it stopped.
 */
import type { GameContext } from 'gameable';

import { HouseSlot } from '../messages';
import { cars } from '../props';
import { MAX_PLAYERS, clearSeat, residents } from '../residents';
import { houseOf } from '../street';
import { savedColor, wear } from './cosmetic';

/** Reused payload. */
const slot = { house: 0 };

/**
 * @param seat A seat that just lost its resident.
 */
function moveOut(seat: number): void {
  const car = residents.car[seat];
  if (car >= 0) {
    cars.driver[car] = -1;
    cars.speed[car] = 0;
  }
  clearSeat(seat);
}

/**
 * The `arrive` system.
 *
 * @param ctx The frame context.
 */
export function arrive(ctx: GameContext): void {
  let count = 0;
  for (let seat = 0; seat < MAX_PLAYERS; seat += 1) {
    const handle = ctx.players.get(seat);
    const entity = handle?.connected === true ? handle.entity : 0;
    if (entity !== 0) count += 1;
    if (entity === residents.entity[seat]) continue;
    if (residents.entity[seat] !== 0) moveOut(seat);
    if (entity === 0) continue;
    residents.entity[seat] = entity;
    residents.house[seat] = houseOf(seat);
    slot.house = houseOf(seat);
    ctx.net.send(HouseSlot, slot, { to: seat });
    const color = savedColor(handle?.data);
    if (color !== '') wear(seat, entity, color);
  }
  residents.count = count;
}
