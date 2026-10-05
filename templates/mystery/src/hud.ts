/**
 * Every player's HUD, written by the authority through their own handle.
 *
 * What each HUD says is `src/hudModel.ts`. This system only decides when to
 * redraw: each HUD is rebuilt on the ticks its few inputs changed (a
 * signature per seat, `round.revision` for readies, votes and chat, and the
 * round clock's whole seconds), so a quiet tick compares numbers and
 * allocates nothing. In solo there are no
 * handles; the one page shows "waiting for players" through `ctx.hud`.
 */
import type { GameContext } from 'gameable';

import { type HudView, model } from './hudModel';
import { hostOf, num, seated } from './lobby';
import { MAX_PLAYERS, MAX_SEATS, OUT_VOTED, PHASE_LIVE, PHASE_VOTE, round } from './round';

/** Last signature drawn per seat; the extra slot at the end is solo's. */
const drawn = new Float64Array(MAX_SEATS + 1);
/** The entity each seat had when it was drawn: a new occupant is always drawn. */
const drawnFor = new Int32Array(MAX_SEATS);
/** `round.revision` when each seat was drawn. */
const drawnAt = new Float64Array(MAX_SEATS);
/** The clock's whole seconds left when each seat was drawn. */
const drawnClock = new Float64Array(MAX_SEATS);
/** This tick's shared view, reused. */
const view: HudView = { ids: new Int32Array(MAX_SEATS), n: 0, host: -1, grace: false, left: 0 };

/** Forget what was drawn. Call from `defineGame({ init })`. */
export function resetHud(): void {
  drawn.fill(-1);
  drawnFor.fill(0);
  drawnAt.fill(-1);
  drawnClock.fill(-1);
}

/**
 * @param id A seated player.
 * @returns The numbers their HUD depends on, packed into one.
 */
function signature(id: number): number {
  const flags =
    (round.isIt(id) ? 1 : 0) |
    (round.out[id] !== 0 ? 2 : 0) |
    (round.playing[id] === 1 ? 4 : 0) |
    (id === view.host ? 8 : 0) |
    (view.grace ? 16 : 0) |
    (round.out[id] === OUT_VOTED ? 32 : 0) |
    (round.ready[id] === 1 ? 64 : 0);
  return (((round.phase * 128 + flags) * 8 + round.winner) * 32 + round.aliveCount()) * 32 + view.n;
}

/**
 * The `roundHud` system.
 *
 * @param ctx The frame context.
 */
export function roundHud(ctx: GameContext): void {
  if (ctx.net.role === 'solo') {
    if (drawn[MAX_SEATS] === 0) return;
    drawn[MAX_SEATS] = 0;
    ctx.hud.set({ text: { players: `1/${String(MAX_PLAYERS)}` }, message: 'waiting for players' });
    return;
  }
  view.grace =
    round.phase === PHASE_LIVE && ctx.elapsed < round.startedAt + num(ctx.rules.graceSeconds, 3);
  const running = round.phase === PHASE_LIVE || round.phase === PHASE_VOTE;
  const ends = round.dealtAt + num(ctx.rules.roundSeconds, 180);
  view.left = running ? Math.max(0, Math.ceil(ends - ctx.elapsed)) : 0;
  view.n = seated(ctx, view.ids);
  view.host = hostOf(ctx);
  for (let i = 0; i < view.n; i += 1) {
    const id = view.ids[i];
    const sig = signature(id);
    const entity = ctx.playerEntity(id);
    const same = drawn[id] === sig && drawnFor[id] === entity && drawnAt[id] === round.revision;
    if (same && drawnClock[id] === view.left) continue;
    drawn[id] = sig;
    drawnFor[id] = entity;
    drawnAt[id] = round.revision;
    drawnClock[id] = view.left;
    ctx.players.get(id)?.hud.set(model(ctx, id, view));
  }
}
