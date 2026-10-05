/**
 * Income. Authority only.
 *
 * Every `rules.incomeSeconds` each seated player is paid
 * `rules.incomePerItem` coins per brainrot in their base, times their rebirth
 * multiplier, and the wallet is saved. A player with nothing earns nothing,
 * and nothing is saved for them.
 */
import type { GameContext } from 'gameable';

import { keep, walletOf } from '../bank';
import { heist, MAX_SEATS } from '../heist';
import { num } from '../rules';
import { payout } from '../wallet';

/**
 * The `income` system.
 *
 * @param ctx The frame context.
 */
export function income(ctx: GameContext): void {
  const every = num(ctx.rules.incomeSeconds, 10);
  const perItem = num(ctx.rules.incomePerItem, 1);
  const bonus = num(ctx.rules.rebirthBonus, 0.5);
  const list = ctx.players.list;
  for (let i = 0; i < list.length; i += 1) {
    const player = list[i].id;
    if (player >= MAX_SEATS || ctx.elapsed < heist.nextPayout[player]) continue;
    const wallet = walletOf(ctx, player);
    if (wallet === undefined) continue;
    heist.nextPayout[player] = ctx.elapsed + every;
    const coins = payout(wallet, perItem, bonus);
    if (coins > 0) keep(ctx, player, { ...wallet, coins: wallet.coins + coins });
  }
}
