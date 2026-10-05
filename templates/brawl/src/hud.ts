/**
 * Every player's HUD, written by the authority through their own handle:
 * their health, their knockouts this round, their rounds won, and what is
 * happening. Rebuilt only on the steps one of those numbers changed (one
 * signature per seat), so a quiet step compares numbers and allocates nothing.
 */
import type { GameContext } from 'gameable';

import { fight, MAX_PLAYERS, num, PHASE_ROUND_OVER } from './fight';

/** The signature last drawn per seat. */
const drawn = new Float64Array(MAX_PLAYERS);

/** Forget what was drawn. Call from `defineGame({ init })`. */
export function resetHud(): void {
  drawn.fill(-1);
}

/**
 * @param seat A seat.
 * @returns The numbers its HUD shows, packed into one.
 */
function signature(seat: number): number {
  const over = fight.phase === PHASE_ROUND_OVER ? 1 + fight.winner : 0;
  return (
    ((Math.ceil(fight.hp[seat]) * 16 + fight.kos[seat]) * 256 + fight.wins[seat]) * 16 +
    over * 2 +
    fight.out[seat]
  );
}

/**
 * The `hud` system. Authority only.
 *
 * @param ctx The frame context.
 */
export function hud(ctx: GameContext): void {
  for (let seat = 0; seat < MAX_PLAYERS; seat += 1) {
    const player = ctx.players.get(seat);
    if (player === undefined || player.entity === 0) continue;
    const sig = signature(seat);
    if (drawn[seat] === sig) continue;
    drawn[seat] = sig;
    const toWin = String(num(ctx.rules.kosToWin, 3));
    let message = `J punch · K dash · L slam · first to ${toWin} knockouts`;
    if (fight.out[seat] === 1) message = 'knocked out: back in a moment';
    if (fight.phase === PHASE_ROUND_OVER) {
      message =
        fight.winner === seat
          ? 'you win the round!'
          : `player ${String(fight.winner + 1)} wins the round`;
    }
    player.hud.set({
      text: {
        hp: String(Math.ceil(fight.hp[seat])),
        kos: String(fight.kos[seat]),
        wins: String(fight.wins[seat]),
      },
      message,
    });
  }
}
