/**
 * The room list's phase: what a player browsing rooms sees beside this
 * room's code and seats. `ctx.net.setPhase` sends only on a change, so
 * saying it every tick costs nothing. Authority only.
 */
import type { GameContext } from 'gameable';

import { PHASE_LIVE, PHASE_VOTE, round } from '../round';

/**
 * The `listing` system.
 *
 * @param ctx The frame context.
 */
export function listing(ctx: GameContext): void {
  const phase = round.phase;
  ctx.net.setPhase(phase === PHASE_LIVE ? 'playing' : phase === PHASE_VOTE ? 'voting' : 'lobby');
}
