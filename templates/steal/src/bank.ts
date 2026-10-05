/**
 * Reading and keeping a seated player's wallet. Authority only.
 *
 * A join normalises the document (`src/systems/seats.ts`), so from then on
 * `PlayerHandle.data` is a `Wallet` and a system reads it without copying.
 * A change is a new object handed to `ctx.data.save`: an allocation, but only
 * on the ticks a document changes. The room writes it at most once per 6 s
 * per player, and always when the player leaves.
 */
import type { GameContext } from 'gameable';

import type { Wallet } from './wallet';

/**
 * @param ctx The frame context.
 * @param player A seated player.
 * @returns Their wallet, read-only; undefined when the seat is empty or not yet loaded.
 */
export function walletOf(ctx: GameContext, player: number): Wallet | undefined {
  const handle = ctx.players.get(player);
  if (handle === undefined || !handle.connected) return undefined;
  const data = handle.data as Wallet | null;
  return data !== null && Array.isArray(data.owned) ? data : undefined;
}

/**
 * Keep a player's new wallet: their `data` shows it at once, and the room saves it.
 *
 * @param ctx The frame context.
 * @param player A seated player.
 * @param wallet The new wallet. Never the object `walletOf` returned, changed in place.
 */
export function keep(ctx: GameContext, player: number, wallet: Wallet): void {
  ctx.data.save(player, wallet);
}
