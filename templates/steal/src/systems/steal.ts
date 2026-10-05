/**
 * Stealing. Authority only.
 *
 * A player who stands in someone else's base for `rules.stealSeconds` takes
 * that player's newest brainrot. The take is ONE `ctx.data.exchange`: the
 * thief gives nothing and takes `{ owned: [id] }`, so the id leaves one
 * document and joins the other together or not at all, in the store as on
 * the authority. The result arrives a tick or more later in
 * `ctx.data.results()`; on success both wallets already show it.
 *
 * No steal from an empty seat, an empty base, or a shielded one; one steal
 * per thief at a time; stepping out of the base starts the count again.
 */
import { Transform, type GameContext } from 'gameable';

import { walletOf } from '../bank';
import { heist, MAX_SEATS, NOBODY } from '../heist';
import { inBase, MAX_PLAYERS } from '../ring';
import { num } from '../rules';

/** Reused payload. */
const stolenPayload = { thief: 0, victim: 0, id: '' };
/** The thief gives nothing. Never changed: `ctx.data` keeps it until the result. */
const GIVE_NOTHING = {};

/**
 * @param ctx The frame context.
 * @param entity A thief's body.
 * @param self The thief, whose own base does not count.
 * @returns The seat whose base the thief stands in, or `NOBODY`.
 */
function baseUnder(ctx: GameContext, entity: number, self: number): number {
  const radius = num(ctx.rules.baseRadius, 1.6);
  for (let seat = 0; seat < MAX_PLAYERS; seat += 1) {
    if (seat !== self && inBase(seat, Transform.x[entity], Transform.z[entity], radius))
      return seat;
  }
  return NOBODY;
}

/**
 * Read this tick's exchange results: tell everyone about a steal that went through.
 *
 * @param ctx The frame context.
 */
function settle(ctx: GameContext): void {
  const results = ctx.data.results();
  for (let i = 0; i < results.length; i += 1) {
    const result = results[i];
    for (let thief = 0; thief < MAX_SEATS; thief += 1) {
      if (heist.pendingExchange[thief] !== result.id) continue;
      if (result.ok) {
        stolenPayload.thief = thief;
        stolenPayload.victim = heist.pendingVictim[thief];
        stolenPayload.id = heist.pendingItem[thief];
        ctx.net.send('stolen', stolenPayload);
      }
      heist.pendingExchange[thief] = 0;
      heist.pendingVictim[thief] = NOBODY;
      heist.pendingItem[thief] = '';
    }
  }
}

/**
 * Start the steal: one exchange between the thief and the victim.
 *
 * @param ctx The frame context.
 * @param thief Who stood there.
 * @param victim Whose base it is.
 */
function attempt(ctx: GameContext, thief: number, victim: number): void {
  const wallet = walletOf(ctx, victim);
  if (wallet === undefined || wallet.owned.length === 0) return;
  if (wallet.shieldUntil > heist.now(ctx)) return;
  const id = wallet.owned[wallet.owned.length - 1];
  // A fresh `take` per steal: `ctx.data` keeps it until the result to apply it.
  heist.pendingExchange[thief] = ctx.data.exchange(thief, victim, GIVE_NOTHING, { owned: [id] });
  heist.pendingVictim[thief] = victim;
  heist.pendingItem[thief] = id;
}

/**
 * The `steal` system.
 *
 * @param ctx The frame context.
 */
export function steal(ctx: GameContext): void {
  settle(ctx);
  const seconds = num(ctx.rules.stealSeconds, 3);
  const list = ctx.players.list;
  for (let i = 0; i < list.length; i += 1) {
    const thief = list[i].id;
    const entity = list[i].entity;
    if (entity === 0 || thief >= MAX_SEATS) continue;
    const victim = baseUnder(ctx, entity, thief);
    if (victim !== heist.standingIn[thief]) {
      heist.standingIn[thief] = victim;
      heist.standing[thief] = 0;
    }
    if (victim === NOBODY || heist.pendingExchange[thief] !== 0) continue;
    heist.standing[thief] += ctx.dt;
    if (heist.standing[thief] < seconds) continue;
    heist.standing[thief] = 0; // the next steal needs another full stand
    attempt(ctx, thief, victim);
  }
}
