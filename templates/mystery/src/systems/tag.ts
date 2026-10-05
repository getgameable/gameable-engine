/**
 * Each "it" touching a crew member tags them out; no crew left ends the
 * round, and otherwise a vote follows. The clock running out gives the round
 * to the crew. Authority only: one `overlap-sphere` a tick per "it", and
 * none at all while the vote is open.
 */
import { Transform, type GameContext } from 'gameable';

import { num } from '../lobby';
import { MAX_SEATS, OUT_TAGGED, PHASE_LIVE, WINNER_IT, WINNER_TIME, round } from '../round';
import { endRound } from './end';
import { openVote } from './vote';

/** Reused query centre. */
const centre = { x: 0, y: 0, z: 0 };
/** Only player bodies can be tagged. */
const PLAYERS = { player: true } as const;

/**
 * Tag whoever one "it" touches.
 *
 * @param ctx The frame context.
 * @param it The "it" player.
 * @returns How many were tagged.
 */
function tagAround(ctx: GameContext, it: number): number {
  const entity = ctx.playerEntity(it);
  if (entity === 0) return 0;
  centre.x = Transform.x[entity];
  centre.y = Transform.y[entity];
  centre.z = Transform.z[entity];
  const radius = num(ctx.rules.tagRadius, 0.9);
  const hits = ctx.physics.overlapSphere(centre, radius, 8, PLAYERS, entity);
  let caught = 0;
  for (let i = 0; i < hits.length; i += 1) {
    const player = round.playerOf(hits[i].entity);
    // Two "it"s cannot tag each other.
    if (round.isIt(player) || !round.alive(player)) continue;
    round.out[player] = OUT_TAGGED;
    caught += 1;
    ctx.net.send('tagged', { player, alive: round.aliveCount() });
  }
  return caught;
}

/**
 * The `tag` system.
 *
 * @param ctx The frame context.
 */
export function tag(ctx: GameContext): void {
  if (round.phase !== PHASE_LIVE) return;
  let caught = 0;
  if (ctx.elapsed >= round.startedAt + num(ctx.rules.graceSeconds, 3)) {
    for (let id = 0; id < MAX_SEATS; id += 1) {
      if (round.isIt(id) && round.alive(id)) caught += tagAround(ctx, id);
    }
  }
  if (round.crewAlive() === 0) endRound(ctx, WINNER_IT);
  else if (ctx.elapsed >= round.dealtAt + num(ctx.rules.roundSeconds, 180)) {
    endRound(ctx, WINNER_TIME);
  } else if (caught > 0) openVote(ctx);
}
