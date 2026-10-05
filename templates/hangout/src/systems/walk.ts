/**
 * Walking: the SDK's third-person controller, camera-relative WASD with
 * Shift to run and a follow camera each. On a room's authority every player
 * walks their own body from their own keys (`updatePlayers`); somebody
 * sitting or driving stands still, and `src/systems/drive.ts` takes over.
 */
import { createThirdPersonController, type GameContext, type PlayerHandle } from 'gameable';

import { residents } from '../residents';

const controller = createThirdPersonController();

/** Forget every seat's walk. Call from `defineGame({ init })`. */
export const resetWalk = controller.reset;

/**
 * @param player A room player.
 * @returns True while they sit or drive: the controller leaves them be.
 */
function busy(player: PlayerHandle): boolean {
  return residents.bench[player.id] !== 0 || residents.car[player.id] >= 0;
}

/**
 * The `walk` system.
 *
 * @param ctx The frame context.
 */
export function walk(ctx: GameContext): void {
  controller.updatePlayers(ctx, busy);
}
