/**
 * Walk every collector: the third-person template's controller, per player.
 *
 * On a room's authority each player walks their own entity from their own
 * keys, with their own follow camera (`updatePlayers`). Alone (the `solo`
 * role, as in a headless test with no seats), the one collector walks from
 * `ctx.input`.
 */
import { createThirdPersonController, type GameContext } from 'gameable';

const controller = createThirdPersonController();

/** Forget every seat's locomotion. Call from `defineGame({ init })`. */
export const resetMove = controller.reset;

/**
 * The `move` system.
 *
 * @param ctx The frame context.
 */
export function move(ctx: GameContext): void {
  if (ctx.net.role === 'solo') controller.update(ctx);
  else if (ctx.net.role === 'authority') controller.updatePlayers(ctx);
}
