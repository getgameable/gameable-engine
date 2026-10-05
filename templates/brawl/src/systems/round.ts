/**
 * Knockouts, respawns and the round, on the authority.
 *
 * A fighter at 0 health is knocked out (`ko` to everyone): they stand still
 * for `respawnSeconds`, then come back at their spawn with full health
 * (`respawn` to everyone). The attacker scores a knockout; the first to
 * `kosToWin` wins the round (`round` `{ winner }` to everyone). The room's
 * phase is `fighting` during a round and `round-over` for `roundOverSeconds`
 * after it, then everyone respawns with no knockouts and it is `fighting`
 * again.
 */
import type { GameContext } from 'gameable';

import { fight, MAX_PLAYERS, num, PHASE_FIGHTING, PHASE_ROUND_OVER, SPAWNS } from '../fight';
import { Ko, Respawn, Round } from '../messages';
import { tint } from '../prefabs';

/** Reused payloads. */
const ko = { by: 0, to: 0 };
const respawned = { player: 0 };
const round = { winner: 0 };

/**
 * Knock a fighter out. Called by `abilities` when a hit takes the last health.
 *
 * @param ctx The frame context.
 * @param by The attacker's seat.
 * @param victim The victim's seat.
 */
export function knockOut(ctx: GameContext, by: number, victim: number): void {
  fight.out[victim] = 1;
  fight.respawnIn[victim] = num(ctx.rules.respawnSeconds, 2);
  ko.by = by;
  ko.to = victim;
  ctx.net.send(Ko, ko);
  fight.kos[by] += 1;
  if (fight.phase === PHASE_FIGHTING && fight.kos[by] >= num(ctx.rules.kosToWin, 3)) {
    fight.phase = PHASE_ROUND_OVER;
    fight.roundOverIn = num(ctx.rules.roundOverSeconds, 4);
    fight.winner = by;
    fight.wins[by] += 1;
    round.winner = by;
    ctx.net.send(Round, round);
  }
}

/**
 * Put a fighter back at their spawn, full health.
 *
 * @param ctx The frame context.
 * @param seat The seat.
 */
function respawn(ctx: GameContext, seat: number): void {
  fight.revive(seat, num(ctx.rules.maxHp, 100));
  const entity = ctx.playerEntity(seat);
  if (entity === 0) return;
  const at = SPAWNS[seat];
  ctx.physics.teleport(entity, at[0], at[1], at[2]);
  tint(entity, 1, 1, 1);
  respawned.player = seat;
  ctx.net.send(Respawn, respawned);
}

/**
 * The `round` system. Authority only.
 *
 * @param ctx The frame context.
 */
export function rounds(ctx: GameContext): void {
  // A seat taken or left starts again, read from the events: a seat can be
  // left and taken again in one step.
  const events = ctx.events;
  for (let i = 0; i < events.length; i += 1) {
    const event = events[i];
    if (event.tag !== 'player-joined' && event.tag !== 'player-left') continue;
    if (event.val.player < MAX_PLAYERS)
      fight.clearSeat(event.val.player, num(ctx.rules.maxHp, 100));
  }

  for (let seat = 0; seat < MAX_PLAYERS; seat += 1) {
    if (fight.out[seat] !== 1) continue;
    fight.respawnIn[seat] -= ctx.dt;
    if (fight.respawnIn[seat] <= 0) respawn(ctx, seat);
  }

  if (fight.phase === PHASE_ROUND_OVER) {
    fight.roundOverIn -= ctx.dt;
    if (fight.roundOverIn <= 0) {
      fight.phase = PHASE_FIGHTING;
      for (let seat = 0; seat < MAX_PLAYERS; seat += 1) {
        fight.kos[seat] = 0;
        respawn(ctx, seat);
      }
    }
  }
  ctx.net.setPhase(fight.phase);
}
