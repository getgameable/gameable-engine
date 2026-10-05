/**
 * The lobby: a round starts when every connected player is ready and there
 * are at least `rules.minPlayers`, or when the host starts it early. Authority
 * only; runs before and after a round (`PHASE_WAITING` and `PHASE_OVER`).
 */
import type { GameContext } from 'gameable';

import { hostOf, num, seated } from '../lobby';
import { Ready, Start } from '../messages';
import { MAX_SEATS, PHASE_LIVE, PHASE_VOTE, round } from '../round';
import { pickIt } from './pickIt';

/** Seated ids this tick, reused. */
const ids = new Int32Array(MAX_SEATS);

/**
 * A seat that is left or taken is not ready: whoever sits there next has to
 * say so themselves. Read from the events, because a seat can be left and
 * taken again in one frame.
 *
 * @param ctx The frame context.
 */
function clearMoved(ctx: GameContext): void {
  const events = ctx.events;
  for (let i = 0; i < events.length; i += 1) {
    const event = events[i];
    if (event.tag !== 'player-joined' && event.tag !== 'player-left') continue;
    const player = event.val.player;
    if (player < 0 || player >= MAX_SEATS || round.ready[player] === 0) continue;
    round.ready[player] = 0;
    round.revision += 1;
  }
}

/**
 * @param ctx The frame context.
 * @returns True when the host sent `start` this tick.
 */
function hostStarted(ctx: GameContext): boolean {
  const starts = ctx.net.messages(Start);
  if (starts.length === 0) return false;
  const host = hostOf(ctx);
  for (let i = 0; i < starts.length; i += 1) if (starts[i].player === host) return true;
  return false;
}

/**
 * The `ready` system.
 *
 * @param ctx The frame context.
 */
export function readyUp(ctx: GameContext): void {
  clearMoved(ctx);
  if (round.phase === PHASE_LIVE || round.phase === PHASE_VOTE) return;
  const readies = ctx.net.messages(Ready);
  for (let i = 0; i < readies.length; i += 1) {
    const player = readies[i].player;
    if (player < 0 || player >= MAX_SEATS || ctx.playerEntity(player) === 0) continue;
    round.ready[player] = round.ready[player] === 1 ? 0 : 1;
    round.revision += 1;
  }
  const forced = hostStarted(ctx);
  const n = seated(ctx, ids);
  if (n < num(ctx.rules.minPlayers, 3)) return;
  let all = true;
  for (let i = 0; i < n && all; i += 1) all = round.ready[ids[i]] === 1;
  if (all || forced) pickIt(ctx, ids, n);
}

/**
 * @param ids The seated players.
 * @param n How many.
 * @returns How many of them are ready.
 */
export function readyCount(ids: Int32Array, n: number): number {
  let ready = 0;
  for (let i = 0; i < n; i += 1) if (round.ready[ids[i]] === 1) ready += 1;
  return ready;
}
