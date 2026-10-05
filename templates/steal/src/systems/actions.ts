/**
 * The shield and the rebirth, from players' messages. Authority only: the
 * authority holds the coins, so a page can ask but never pay itself.
 *
 * - `shield`, for `rules.shieldCost` coins: nobody steals from your base for
 *   `rules.shieldSeconds`. It is kept in the wallet (`shieldUntil`, server
 *   time), so leaving and coming back does not drop it.
 * - `rebirth`, once you hold `rules.rebirthCost` coins: your coins and your
 *   brainrots go, and every payout after is worth `rules.rebirthBonus` more.
 */
import type { GameContext } from 'gameable';

import { keep, walletOf } from '../bank';
import { heist, MAX_SEATS } from '../heist';
import { Rebirth, Shield } from '../messages';
import { num } from '../rules';

/** Reused payload. */
const shieldedPayload = { player: 0 };

/**
 * @param ctx The frame context.
 * @param player Who asked.
 */
function shield(ctx: GameContext, player: number): void {
  const wallet = walletOf(ctx, player);
  const cost = num(ctx.rules.shieldCost, 10);
  if (wallet === undefined || wallet.coins < cost) return;
  const now = heist.now(ctx);
  if (wallet.shieldUntil > now) return; // already up: no paying twice
  const until = now + num(ctx.rules.shieldSeconds, 20) * 1000;
  keep(ctx, player, { ...wallet, coins: wallet.coins - cost, shieldUntil: until });
  shieldedPayload.player = player;
  ctx.net.send('shielded', shieldedPayload);
}

/**
 * @param ctx The frame context.
 * @param player Who asked.
 */
function rebirth(ctx: GameContext, player: number): void {
  const wallet = walletOf(ctx, player);
  if (wallet === undefined || wallet.coins < num(ctx.rules.rebirthCost, 100)) return;
  // Not while a steal from this base waits for its exchange: the store would
  // keep the steal and drop the rebirth.
  for (let thief = 0; thief < MAX_SEATS; thief += 1) {
    if (heist.pendingExchange[thief] !== 0 && heist.pendingVictim[thief] === player) return;
  }
  keep(ctx, player, { ...wallet, coins: 0, owned: [], rebirths: wallet.rebirths + 1 });
}

/**
 * The `actions` system.
 *
 * @param ctx The frame context.
 */
export function actions(ctx: GameContext): void {
  const shields = ctx.net.messages(Shield);
  for (let i = 0; i < shields.length; i += 1) shield(ctx, shields[i].player);
  const rebirths = ctx.net.messages(Rebirth);
  for (let i = 0; i < rebirths.length; i += 1) rebirth(ctx, rebirths[i].player);
}
