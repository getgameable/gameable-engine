/**
 * Reading and writing a player's document on the authority. The document is
 * `ctx.players.get(id).data`; `ctx.data.save` replaces it at once and the room
 * writes it to its store (at most once every 6 s, and always when they leave).
 */
import type { GameContext } from 'gameable';

import { collection, MAX_SEATS } from './collection';
import { emptyDoc, isCollectDoc, type CollectDoc } from './pets';
import { num } from './rules';

/**
 * @param ctx The frame context.
 * @param player A player.
 * @returns Their document, or null when they are not here (a seat held for a
 *   reconnect included), have none yet, or it is malformed.
 */
export function docOf(ctx: GameContext, player: number): CollectDoc | null {
  const handle = ctx.players.get(player);
  if (handle === undefined || !handle.connected) return null;
  const data = handle.data;
  return isCollectDoc(data) ? data : null;
}

/**
 * @param ctx The frame context.
 * @param player A joining player.
 * @returns Their document, or a fresh one with `rules.startBucks`.
 */
export function docOrEmpty(ctx: GameContext, player: number): CollectDoc {
  return docOf(ctx, player) ?? emptyDoc(num(ctx.rules.startBucks, 0));
}

/**
 * Keep a player's new document, and have their pets and HUD catch up.
 *
 * @param ctx The frame context.
 * @param player The player.
 * @param doc Their whole new document (a new object: never edit the old one).
 */
export function saveDoc(ctx: GameContext, player: number, doc: CollectDoc): void {
  ctx.data.save(player, doc);
  if (player >= 0 && player < MAX_SEATS) collection.dirty[player] = 1;
}

/**
 * Tell one player why their message did nothing.
 *
 * @param ctx The frame context.
 * @param player Who sent it.
 * @param what The message, such as `offer`.
 * @param reason Why, such as `short`.
 */
export function refuse(ctx: GameContext, player: number, what: string, reason: string): void {
  ctx.net.send('refused', { what, reason }, { to: player });
}
