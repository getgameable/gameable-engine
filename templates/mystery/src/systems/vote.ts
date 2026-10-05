/**
 * The vote after a tag-out. Every player still in names who they think is
 * "it"; a majority of them puts that player out. The last "it" still in
 * voted out: the crew wins. Anyone else (another "it" included, unnamed as
 * such): the round goes on after a fresh grace period. No majority in
 * `rules.voteSeconds`: nobody is out. Authority only.
 */
import type { GameContext } from 'gameable';

import { num } from '../lobby';
import { Vote } from '../messages';
import { OUT_VOTED, PHASE_LIVE, PHASE_VOTE, WINNER_IT, WINNER_VOTE, round } from '../round';
import { endRound } from './end';

/**
 * Open a vote. Called by `tag` after a tag-out that leaves two or more in.
 *
 * @param ctx The frame context.
 */
export function openVote(ctx: GameContext): void {
  round.phase = PHASE_VOTE;
  round.ballot.clear();
  round.ballot.openedAt = ctx.elapsed;
  round.revision += 1;
  ctx.net.send('vote-open', { alive: round.aliveCount() });
}

/**
 * Close the vote.
 *
 * @param ctx The frame context.
 * @param out The player voted out, or -1 for nobody.
 */
function closeVote(ctx: GameContext, out: number): void {
  if (out >= 0) round.out[out] = OUT_VOTED;
  if (out >= 0 && round.itsAlive() === 0) {
    endRound(ctx, WINNER_VOTE);
    return;
  }
  round.ballot.clear();
  round.phase = PHASE_LIVE;
  // A fresh grace period: everyone was standing around talking.
  round.startedAt = ctx.elapsed;
  round.revision += 1;
  ctx.net.send('vote-over', { out, alive: round.aliveCount() });
  if (round.crewAlive() === 0) endRound(ctx, WINNER_IT);
}

/**
 * Take this tick's votes. A vote from a player not still in the round, or
 * for one, is refused and counted in `round.ballot.rejected`.
 *
 * @param ctx The frame context.
 */
function take(ctx: GameContext): void {
  const votes = ctx.net.messages(Vote);
  for (let i = 0; i < votes.length; i += 1) {
    const voter = votes[i].player;
    const target = votes[i].payload.for;
    if (!round.alive(voter) || !round.alive(target)) {
      round.ballot.rejected += 1;
      continue;
    }
    if (round.ballot.cast(voter, target)) round.revision += 1;
  }
}

/**
 * The `vote` system.
 *
 * @param ctx The frame context.
 */
export function vote(ctx: GameContext): void {
  if (round.phase !== PHASE_VOTE) return;
  take(ctx);
  const alive = round.aliveCount();
  if (round.crewAlive() === 0) {
    endRound(ctx, WINNER_IT);
    return;
  }
  const out = round.ballot.winner(Math.floor(alive / 2) + 1);
  if (out >= 0) closeVote(ctx, out);
  else if (ctx.elapsed >= round.ballot.openedAt + num(ctx.rules.voteSeconds, 30)) {
    closeVote(ctx, -1);
  }
}
