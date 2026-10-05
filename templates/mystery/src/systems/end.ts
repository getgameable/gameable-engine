/**
 * Ending the round, and the players who leave it while it runs. Authority only.
 */
import type { GameContext } from 'gameable';

import {
  MAX_SEATS,
  PHASE_LIVE,
  PHASE_OVER,
  PHASE_VOTE,
  WINNER_IT,
  WINNER_CREW,
  round,
} from '../round';

/**
 * End the round and say so to everyone. The one send that names "it": `its`
 * lists every player dealt "it", in seat order.
 *
 * @param ctx The frame context.
 * @param winner One of the `WINNER_*` constants.
 */
export function endRound(ctx: GameContext, winner: number): void {
  round.phase = PHASE_OVER;
  round.winner = winner;
  round.ballot.clear();
  const its: number[] = [];
  for (let id = 0; id < MAX_SEATS; id += 1) if (round.isIt(id)) its.push(id);
  ctx.net.send('round-over', { its, winner: winner === WINNER_IT ? 'it' : 'crew' });
}

/**
 * The `leavers` system. Anyone in the round who left the room this frame
 * leaves the round, and takes their vote and the votes for them along, so a
 * quitter cannot keep the round or the vote from ending. Read from the
 * `player-left` events, not from the seat, because a seat can be left and
 * taken again in one frame. The last "it" still in walking out gives the
 * round to the crew.
 *
 * @param ctx The frame context.
 */
export function leavers(ctx: GameContext): void {
  if (round.phase !== PHASE_LIVE && round.phase !== PHASE_VOTE) return;
  let left = false;
  const events = ctx.events;
  for (let i = 0; i < events.length; i += 1) {
    const event = events[i];
    if (event.tag !== 'player-left') continue;
    const player = event.val.player;
    left = true;
    round.leave(player);
    round.ballot.forget(player);
    round.revision += 1;
  }
  if (left && round.itsAlive() === 0) endRound(ctx, WINNER_CREW);
}
