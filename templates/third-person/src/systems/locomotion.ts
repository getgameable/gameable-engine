/** Camera-relative controller shared with standalone games. */
import { createThirdPersonController, type GameContext, type PlayerHandle } from 'gameable';
import { dialogueOf, dialogueState } from './dialogue';
export const IDLE = 'idle';
export const WALK = 'walk';
export const RUN = 'run';
export const JUMP = 'jump';
export const FALL = 'fall';
const controller = createThirdPersonController();
export const locomotionState = controller.state;
export const resetLocomotion = controller.reset;
/** A room player's locomotion state, by player id; undefined before they first moved. */
export const playerLocomotion = controller.stateOf;
/**
 * @param player A room player.
 * @returns True while that player is in a conversation: they alone stand still.
 */
function talking(player: PlayerHandle): boolean {
  return dialogueOf(player.id)?.active === true;
}
/**
 * Update movement; the template freezes a player during their dialogue.
 *
 * Alone, the hero walks from this page's keys. On a room's authority, each
 * player walks their own entity (the one they possess) from their own keys,
 * with their own camera. A client moves nothing: the authority does.
 */
export function locomotionSystem(ctx: GameContext): void {
  if (ctx.net.role === 'solo') controller.update(ctx, dialogueState.active);
  else if (ctx.net.role === 'authority') controller.updatePlayers(ctx, talking);
}
