/**
 * Eggs and pets, on the authority: `buy` an egg for `rules.eggCost` bucks;
 * it hatches `rules.hatchSeconds` later into a pet whose kind is drawn with
 * `ctx.rng` (`src/pets.ts`); `combine` turns four pets of one kind and tier
 * into one of the next tier. A player mid-trade can do neither.
 */
import type { GameContext } from 'gameable';

import { collection, MAX_SEATS } from '../collection';
import { docOf, refuse, saveDoc } from '../docs';
import { Buy, Combine } from '../messages';
import { drawKind, EGG_KIND, newPetId, type CollectDoc, type Pet } from '../pets';
import { num } from '../rules';

/** Pets that combine into one. */
export const COMBINE_COUNT = 4;

/**
 * @param ctx The frame context.
 * @param player The buyer.
 */
function buy(ctx: GameContext, player: number): void {
  const doc = docOf(ctx, player);
  const cost = num(ctx.rules.eggCost, 25);
  if (doc === null || collection.busy[player] === 1) return refuse(ctx, player, 'buy', 'busy');
  if (doc.bucks < cost) return refuse(ctx, player, 'buy', 'short');
  if (doc.eggs.length >= num(ctx.rules.maxEggs, 3)) return refuse(ctx, player, 'buy', 'full');
  const egg = { kind: EGG_KIND, hatchAt: ctx.elapsed + num(ctx.rules.hatchSeconds, 10) };
  saveDoc(ctx, player, { bucks: doc.bucks - cost, pets: doc.pets, eggs: [...doc.eggs, egg] });
}

/**
 * Hatch every egg whose time has come.
 *
 * @param ctx The frame context.
 * @param player Whose eggs.
 * @param doc Their document.
 */
function hatch(ctx: GameContext, player: number, doc: CollectDoc): void {
  const pets = [...doc.pets];
  const eggs = doc.eggs.filter((egg) => {
    if (egg.hatchAt > ctx.elapsed) return true;
    const pet = { id: newPetId(ctx.rng), kind: drawKind(ctx.rng), tier: 1 };
    pets.push(pet);
    ctx.net.send('hatched', pet, { to: player });
    return false;
  });
  saveDoc(ctx, player, { bucks: doc.bucks, pets, eggs });
}

/**
 * @param ctx The frame context.
 * @param player The combiner.
 * @param want The kind and tier to combine, or null for the first four found.
 */
function combine(
  ctx: GameContext,
  player: number,
  want: { kind: string; tier: number } | null,
): void {
  const doc = docOf(ctx, player);
  if (doc === null || collection.busy[player] === 1) return refuse(ctx, player, 'combine', 'busy');
  const top = num(ctx.rules.maxTier, 5);
  const like = (a: Pet, b: { kind: string; tier: number }): boolean =>
    a.kind === b.kind && a.tier === b.tier;
  const pick =
    want ??
    doc.pets.find(
      (p) => p.tier < top && doc.pets.filter((q) => like(q, p)).length >= COMBINE_COUNT,
    );
  const same =
    pick === undefined ? [] : doc.pets.filter((p) => like(p, pick)).slice(0, COMBINE_COUNT);
  if (pick === undefined || same.length < COMBINE_COUNT || pick.tier >= top) {
    return refuse(ctx, player, 'combine', 'need-four');
  }
  const pets = doc.pets.filter((p) => !same.includes(p));
  pets.push({ id: newPetId(ctx.rng), kind: pick.kind, tier: pick.tier + 1 });
  saveDoc(ctx, player, { bucks: doc.bucks, pets, eggs: doc.eggs });
}

/**
 * The `shop` system.
 *
 * @param ctx The frame context.
 */
export function shop(ctx: GameContext): void {
  const buys = ctx.net.messages(Buy);
  for (let i = 0; i < buys.length; i += 1) buy(ctx, buys[i].player);
  const combines = ctx.net.messages(Combine);
  for (let i = 0; i < combines.length; i += 1)
    combine(ctx, combines[i].player, combines[i].payload);
  for (let player = 0; player < MAX_SEATS; player += 1) {
    const doc = docOf(ctx, player);
    if (doc === null) continue;
    for (let i = 0; i < doc.eggs.length; i += 1) {
      if (doc.eggs[i].hatchAt > ctx.elapsed) continue;
      hatch(ctx, player, doc);
      break;
    }
  }
}
