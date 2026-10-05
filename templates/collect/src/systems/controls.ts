/**
 * The client's half: keys become messages to the authority, and what the
 * authority says to this player plays a sound on this page only.
 *
 * B buys an egg, C combines four identical pets, T sends the deal the
 * authority last suggested (`deal`) as an `offer`, Y accepts the last offer (`offered`)
 * made to this player.
 */
import type { GameContext } from 'gameable';

import { Accept, Buy, Combine, Offer, type TradeSide } from '../messages';

/** What the authority last said, kept on this page. Reset in `init`. */
const last = {
  deal: null as { to: number; give: TradeSide; take: TradeSide } | null,
  offerId: 0,
};

/** Forget the last deal and offer. Call from `defineGame({ init })`. */
export function resetControls(): void {
  last.deal = null;
  last.offerId = 0;
}

/**
 * The `controls` system.
 *
 * @param ctx The frame context.
 */
export function controls(ctx: GameContext): void {
  // Solo runs every system, but there is nobody to send to.
  if (ctx.net.role === 'solo') return;
  const deals = ctx.net.messages<{ to: number; give?: TradeSide; take?: TradeSide }>('deal');
  for (let i = 0; i < deals.length; i += 1) {
    const d = deals[i].payload;
    last.deal =
      d.to < 0 || d.give === undefined || d.take === undefined ? null : (d as typeof last.deal);
  }
  const offers = ctx.net.messages<{ offerId: number }>('offered');
  for (let i = 0; i < offers.length; i += 1) last.offerId = offers[i].payload.offerId;

  if (ctx.input.pressed('KeyB')) ctx.net.send(Buy, null);
  if (ctx.input.pressed('KeyC')) ctx.net.send(Combine, null);
  if (ctx.input.pressed('KeyT') && last.deal !== null) ctx.net.send(Offer, last.deal);
  if (ctx.input.pressed('KeyY') && last.offerId !== 0)
    ctx.net.send(Accept, { offerId: last.offerId });

  if (ctx.net.messages('coin').length > 0) ctx.audio.play('sfx.coin');
  if (ctx.net.messages('hatched').length > 0 || ctx.net.messages('trade').length > 0) {
    ctx.audio.play('sfx.hatch');
  }
}
