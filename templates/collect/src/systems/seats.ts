/**
 * Joins and leaves, on the authority. A joining player gets their saved
 * document (`p.data`, loaded by the room) or a fresh one, and their eggs are
 * re-timed for this room. A leaving player's pets go, and every offer from or
 * to them is dropped. The room writes the leaver's document to its store.
 */
import type { GameContext } from 'gameable';

import { collection, MAX_SEATS, VISIBLE_PETS } from '../collection';
import { docOf, docOrEmpty, saveDoc } from '../docs';
import { num } from '../rules';
import { forgetDeal } from './deals';

/**
 * `hatchAt` is in the clock of the room the egg was bought in. In another
 * room no egg waits longer than `rules.hatchSeconds` from the join.
 *
 * @param ctx The frame context.
 * @param player The joining player.
 */
function arrive(ctx: GameContext, player: number): void {
  const saved = docOf(ctx, player);
  const doc = docOrEmpty(ctx, player);
  const latest = ctx.elapsed + num(ctx.rules.hatchSeconds, 10);
  const late = doc.eggs.some((egg) => egg.hatchAt > latest);
  if (saved === null || late) {
    const eggs = doc.eggs.map((egg) => ({
      kind: egg.kind,
      hatchAt: Math.min(egg.hatchAt, latest),
    }));
    saveDoc(ctx, player, { bucks: doc.bucks, pets: doc.pets, eggs });
  }
  collection.dirty[player] = 1;
}

/**
 * @param ctx The frame context.
 * @param player The seat left.
 */
function depart(ctx: GameContext, player: number): void {
  for (let slot = 0; slot < VISIBLE_PETS; slot += 1) {
    const at = player * VISIBLE_PETS + slot;
    if (collection.petEntity[at] !== 0) ctx.despawn(collection.petEntity[at]);
    collection.petEntity[at] = 0;
    collection.petShown[at] = '';
  }
  collection.dropOffers(player);
  collection.offerText[player] = '';
  collection.busy[player] = 0;
}

/**
 * The `seats` system. Read from the events, because a seat can be left and
 * taken again in one frame.
 *
 * @param ctx The frame context.
 */
export function seats(ctx: GameContext): void {
  const events = ctx.events;
  for (let i = 0; i < events.length; i += 1) {
    const event = events[i];
    if (event.tag !== 'player-joined' && event.tag !== 'player-left') continue;
    const player = event.val.player;
    if (player < 0 || player >= MAX_SEATS) continue;
    forgetDeal(player);
    if (event.tag === 'player-left') depart(ctx, player);
    else arrive(ctx, player);
  }
}
