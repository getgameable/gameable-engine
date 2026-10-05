/**
 * Walk every survivor: the third-person template's controller, per player.
 *
 * On a room's authority each player walks their own entity from their own
 * keys, with their own follow camera (`updatePlayers`); a downed player stands
 * still until dawn. Alone (the `solo` role, as in the headless tests), the one
 * survivor walks from `ctx.input`.
 */
import { createThirdPersonController, type GameContext, type PlayerHandle } from 'gameable';

import { camp } from '../camp';

const controller = createThirdPersonController();

/** Forget every seat's locomotion. Call from `defineGame({ init })`. */
export const resetMove = controller.reset;

/**
 * Hoisted, because a function made per tick allocates.
 *
 * @param player A room player.
 * @returns True while they are down.
 */
function down(player: PlayerHandle): boolean {
  return camp.downed[player.id] === 1;
}

/**
 * The `move` system.
 *
 * @param ctx The frame context.
 */
export function move(ctx: GameContext): void {
  if (ctx.net.role === 'solo') controller.update(ctx);
  else if (ctx.net.role === 'authority') controller.updatePlayers(ctx, down);
}
