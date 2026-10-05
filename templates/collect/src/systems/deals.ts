/**
 * The deal T would offer, on the authority: for each player, the nearest
 * other player within `rules.tradeRange`, and a one-for-one swap of their
 * newest pets (or `rules.dealBucks` bucks on a side with no pet). It is sent
 * to that player as `deal` whenever it changes, so their page can send it as
 * an `offer` with one key. Any `offer` a page builds itself works the same.
 */
import { Transform, type GameContext } from 'gameable';

import { MAX_SEATS } from '../collection';
import { docOf } from '../docs';
import type { TradeSide } from '../messages';
import { num } from '../rules';

/** Per seat: the partner, and the two pet ids, the last deal was made of. */
const dealTo = new Int32Array(MAX_SEATS).fill(-1);
const dealMine: string[] = new Array<string>(MAX_SEATS).fill('');
const dealTheirs: string[] = new Array<string>(MAX_SEATS).fill('');
/** The payload that clears a deal. */
const NO_DEAL = { to: -1 };

/** Forget every deal. Call from `defineGame({ init })`. */
export function resetDeals(): void {
  dealTo.fill(-1);
  dealMine.fill('');
  dealTheirs.fill('');
}

/** @param seat A seat taken or left: its next deal is sent whatever it is. */
export function forgetDeal(seat: number): void {
  dealTo[seat] = -2;
}

/**
 * @param ctx The frame context.
 * @param seat A player.
 * @param entity Their entity.
 * @returns The nearest other player within range, or -1.
 */
function nearest(ctx: GameContext, seat: number, entity: number): number {
  let best = -1;
  let bestD = num(ctx.rules.tradeRange, 3);
  for (let other = 0; other < MAX_SEATS; other += 1) {
    const e = other === seat ? 0 : ctx.playerEntity(other);
    if (e === 0) continue;
    const d = Math.hypot(
      Transform.x[e] - Transform.x[entity],
      Transform.z[e] - Transform.z[entity],
    );
    if (d <= bestD) {
      best = other;
      bestD = d;
    }
  }
  return best;
}

/**
 * @param id A pet id, or ''.
 * @param bucks What to ask for instead.
 * @returns The trade side.
 */
function side(id: string, bucks: number): TradeSide {
  return id === '' ? { bucks } : { pets: [id] };
}

/**
 * The `deals` system.
 *
 * @param ctx The frame context.
 */
export function deals(ctx: GameContext): void {
  for (let seat = 0; seat < MAX_SEATS; seat += 1) {
    const entity = ctx.playerEntity(seat);
    if (entity === 0) continue;
    let to = nearest(ctx, seat, entity);
    const mine = docOf(ctx, seat)?.pets;
    const theirs = to < 0 ? undefined : docOf(ctx, to)?.pets;
    const mineId = mine?.[mine.length - 1]?.id ?? '';
    const theirsId = theirs?.[theirs.length - 1]?.id ?? '';
    if (mineId === '' && theirsId === '') to = -1;
    if (to === dealTo[seat] && mineId === dealMine[seat] && theirsId === dealTheirs[seat]) continue;
    dealTo[seat] = to;
    dealMine[seat] = mineId;
    dealTheirs[seat] = theirsId;
    const bucks = num(ctx.rules.dealBucks, 20);
    const payload =
      to < 0 ? NO_DEAL : { to, give: side(mineId, bucks), take: side(theirsId, bucks) };
    ctx.net.send('deal', payload, { to: seat });
  }
}
