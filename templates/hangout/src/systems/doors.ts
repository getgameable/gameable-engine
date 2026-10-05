/**
 * The front doors, shared by everyone: one player's E opens a door for the
 * whole street, and it slides sideways until it is open (or back until it is
 * shut). A kinematic body moved with `physics.teleport`, only while it moves.
 */
import type { GameContext } from 'gameable';

import { doors } from '../props';
import { num } from '../residents';

/**
 * The `doors` system.
 *
 * @param ctx The frame context.
 */
export function slideDoors(ctx: GameContext): void {
  const travel = num(ctx.rules.doorTravel, 1.2);
  const step = num(ctx.rules.doorSpeed, 2) * ctx.dt;
  for (let i = 0; i < doors.entity.length; i += 1) {
    const goal = doors.open[i] === 1 ? travel : 0;
    const slid = doors.slid[i];
    if (slid === goal || doors.entity[i] === 0) continue;
    doors.slid[i] = goal > slid ? Math.min(goal, slid + step) : Math.max(goal, slid - step);
    ctx.physics.teleport(doors.entity[i], doors.x[i] + doors.slid[i], doors.y[i], doors.z[i]);
  }
}
