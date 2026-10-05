/**
 * Joins and leaves. Authority only.
 *
 * A join reads the player's saved wallet (`PlayerHandle.data`, loaded by the
 * room), pays them for the time they were away (from `savedAt` to the
 * server's clock at the join, `joinedAt`, capped at `rules.offlineCapHours`),
 * and saves the result, so their `data` is a clean `Wallet` from here on. The
 * first join that carries the server's clock sets the heist's clock.
 *
 * The room's phase is always `open`: there are no rounds to wait for.
 *
 * A leave clears the seat's timers. The room itself writes the player's last
 * saved wallet when they leave: nothing to do here for that.
 */
import type { GameContext } from 'gameable';

import { keep } from '../bank';
import { heist } from '../heist';
import { num } from '../rules';
import { offlineIncome, readWallet } from '../wallet';

/** Reused payload and options. */
const awayPayload = { coins: 0 };
const toOne = { to: 0 };

/**
 * A player sat down: load, pay for the time away, save.
 *
 * @param ctx The frame context.
 * @param player The seat.
 */
function arrive(ctx: GameContext, player: number): void {
  heist.clearSeat(player);
  const handle = ctx.players.get(player);
  if (handle === undefined) return;
  if (handle.joinedAt !== null) heist.clockAnchor = handle.joinedAt - ctx.elapsed * 1000;
  const wallet = readWallet(handle.data);
  const away = offlineIncome(wallet, handle.savedAt, handle.joinedAt, {
    everySeconds: num(ctx.rules.incomeSeconds, 10),
    capSeconds: num(ctx.rules.offlineCapHours, 8) * 3600,
    perItem: num(ctx.rules.incomePerItem, 1),
    rebirthBonus: num(ctx.rules.rebirthBonus, 0.5),
  });
  wallet.coins += away;
  keep(ctx, player, wallet);
  heist.nextPayout[player] = ctx.elapsed + num(ctx.rules.incomeSeconds, 10);
  if (away > 0) {
    awayPayload.coins = away;
    toOne.to = player;
    ctx.net.send('away', awayPayload, toOne);
  }
}

/**
 * The `seats` system.
 *
 * @param ctx The frame context.
 */
export function seats(ctx: GameContext): void {
  // Anyone may join at any time: the room list shows the room as open.
  ctx.net.setPhase('open');
  const events = ctx.events;
  for (let i = 0; i < events.length; i += 1) {
    const event = events[i];
    if (event.tag === 'player-joined') arrive(ctx, event.val.player);
    else if (event.tag === 'player-left') heist.clearSeat(event.val.player);
  }
}
