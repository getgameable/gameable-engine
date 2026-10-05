/**
 * Every player's HUD, written by the authority through their own handle:
 * their bucks, pets and eggs, the offer waiting for them, and what to do.
 *
 * A HUD is rebuilt only when that player's document or offer changed (the
 * `dirty` lane) or their next egg's countdown ticked over, so a quiet tick
 * compares numbers and allocates nothing. It runs last and clears `dirty`.
 */
import type { GameContext } from 'gameable';

import { collection, MAX_PLAYERS, MAX_SEATS } from './collection';
import { docOf } from './docs';
import type { CollectDoc } from './pets';
import { num } from './rules';

/** The countdown last drawn per seat; the extra slot at the end is solo's. */
const drawn = new Int32Array(MAX_SEATS + 1);

/** Forget what was drawn. Call from `defineGame({ init })`. */
export function resetHud(): void {
  drawn.fill(-1);
}

/**
 * @param ctx The frame context.
 * @param doc A document.
 * @returns Whole seconds until its next egg hatches, or 0 for no egg.
 */
function nextHatch(ctx: GameContext, doc: CollectDoc): number {
  let soonest = Infinity;
  for (let i = 0; i < doc.eggs.length; i += 1) soonest = Math.min(soonest, doc.eggs[i].hatchAt);
  return soonest === Infinity ? 0 : Math.max(1, Math.ceil(soonest - ctx.elapsed));
}

/**
 * @param ctx The frame context.
 * @param id A player.
 * @param doc Their document.
 * @param left Seconds to their next hatch.
 * @returns What their HUD says.
 */
function model(
  ctx: GameContext,
  id: number,
  doc: CollectDoc,
  left: number,
): Record<string, unknown> {
  const cost = String(num(ctx.rules.eggCost, 25));
  const eggs =
    doc.eggs.length === 0 ? '0' : `${String(doc.eggs.length)} · next in ${String(left)} s`;
  const offer = collection.offerText[id];
  return {
    text: { bucks: String(doc.bucks), pets: String(doc.pets.length), eggs },
    message:
      offer !== ''
        ? offer
        : `walk over coins · B buys an egg (${cost}) · C combines four · T offers a trade nearby`,
  };
}

/**
 * The `hud` system.
 *
 * @param ctx The frame context.
 */
export function hud(ctx: GameContext): void {
  if (ctx.net.role === 'solo') {
    if (drawn[MAX_SEATS] === 0) return;
    drawn[MAX_SEATS] = 0;
    ctx.hud.set({ text: { players: `1/${String(MAX_PLAYERS)}` }, message: 'waiting for a room' });
    return;
  }
  for (let id = 0; id < MAX_SEATS; id += 1) {
    const doc = docOf(ctx, id);
    const handle = ctx.players.get(id);
    if (doc === null || handle === undefined) continue;
    const left = nextHatch(ctx, doc);
    if (collection.dirty[id] === 0 && drawn[id] === left) continue;
    drawn[id] = left;
    collection.dirty[id] = 0;
    handle.hud.set(model(ctx, id, doc, left));
  }
}
