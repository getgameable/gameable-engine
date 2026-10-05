/**
 * Deal a round: pick `rules.its` players to be "it" with `ctx.rng`, tell only
 * them, and move everyone onto the starting ring. Authority only; the lobby
 * (`ready.ts`) decides when.
 */
import type { GameContext } from 'gameable';

import { seat } from '../arena';
import { nameOf, num } from '../lobby';
import { MAX_SEATS, round } from '../round';

/** Reused seat position. */
const at = { x: 0, y: 0, z: 0 };
/** The seated ids, shuffled in place by the draw. */
const deck = new Int32Array(MAX_SEATS);

/**
 * How many "it"s a round of `n` gets: `rules.its`, at least one, and always
 * at least one crew member left to tag.
 *
 * @param ctx The frame context.
 * @param n Players dealt in.
 * @returns The count.
 */
export function itsFor(ctx: GameContext, n: number): number {
  const wanted = Math.floor(num(ctx.rules.its, 1));
  return Math.max(1, Math.min(wanted, n - 1));
}

/**
 * Deal a round to the seated players.
 *
 * @param ctx The frame context.
 * @param ids The seated players, ascending.
 * @param n How many of `ids` to deal in.
 */
export function pickIt(ctx: GameContext, ids: Int32Array, n: number): void {
  round.begin(ctx.elapsed);
  // The round's random draws, from the seeded generator: the same seed and the
  // same seats pick the same players, on every run and in both modes. A
  // partial Fisher-Yates shuffle: draw k of the n, without repeats.
  for (let i = 0; i < n; i += 1) deck[i] = ids[i];
  const k = itsFor(ctx, n);
  for (let i = 0; i < k; i += 1) {
    const j = i + ctx.rng.int(n - i);
    const picked = deck[j];
    deck[j] = deck[i];
    deck[i] = picked;
    // Seat and cleaned name, as every HUD shows a player: names are not unique.
    round.makeIt(picked, `#${String(picked + 1)} ${nameOf(ctx, picked)}`);
  }
  for (let i = 0; i < n; i += 1) {
    const entity = ctx.playerEntity(ids[i]);
    round.seat(ids[i], entity);
    seat(i, n, at);
    ctx.physics.teleport(entity, at.x, at.y, at.z);
  }
  // Everyone hears that a round began and how many "it"s it has; nobody hears
  // who. That goes through each "it"'s own HUD (`src/hud.ts`).
  ctx.net.send('round', { players: n, its: k });
}
