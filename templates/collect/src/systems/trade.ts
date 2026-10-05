/**
 * Trades, on the authority, in two messages:
 *
 * 1. `offer { to, give, take }`: the sender gives `give` and takes `take`.
 *    Refused unless both players hold what they would hand over. It stays
 *    open until `to` accepts, the sender makes another offer, or either leaves.
 * 2. `accept { offerId }` from `to`: checked again against both documents as
 *    they are now (an offer the documents no longer match is stale), then ONE
 *    `ctx.data.exchange`, all or nothing in the room's store. A failed
 *    exchange changes neither document.
 *
 * Both players are told how it ended with `trade`.
 */
import { applyTransfer, type GameContext, type TransferDoc } from 'gameable';

import { collection, MAX_SEATS } from '../collection';
import { docOf, refuse } from '../docs';
import { Accept, Offer, type TradeSide } from '../messages';
import type { CollectDoc, Pet } from '../pets';

/**
 * A trade side on the wire, as the documents' own terms: pets by value.
 *
 * @param doc The giver's document.
 * @param side What they hand over.
 * @returns The side as a transfer, or null when the giver lacks a pet.
 */
function asTransfer(doc: CollectDoc, side: TradeSide): TransferDoc | null {
  const out: TransferDoc = {};
  if (side.bucks !== undefined && side.bucks > 0) out.bucks = side.bucks;
  if (side.pets !== undefined && side.pets.length > 0) {
    const pets: Pet[] = [];
    for (const id of side.pets) {
      const pet = doc.pets.find((p) => p.id === id);
      if (pet === undefined || pets.includes(pet)) return null;
      pets.push(pet);
    }
    out.pets = pets;
  }
  return out;
}

/**
 * @param side A transfer.
 * @returns It in words, such as `20 bucks + cat 2`.
 */
export function describe(side: TransferDoc): string {
  const parts: string[] = [];
  if (typeof side.bucks === 'number') parts.push(`${String(side.bucks)} bucks`);
  for (const pet of (side.pets ?? []) as Pet[]) parts.push(`${pet.kind} ${String(pet.tier)}`);
  return parts.length === 0 ? 'nothing' : parts.join(' + ');
}

/**
 * @param ctx The frame context.
 * @param from The sender.
 * @param p The offer.
 */
function offer(
  ctx: GameContext,
  from: number,
  p: { to: number; give: TradeSide; take: TradeSide },
): void {
  const to = p.to;
  const mine = docOf(ctx, from);
  const theirs = to >= 0 && to < MAX_SEATS && to !== from ? docOf(ctx, to) : null;
  if (mine === null || theirs === null) return refuse(ctx, from, 'offer', 'no-player');
  const give = asTransfer(mine, p.give);
  if (give === null) return refuse(ctx, from, 'offer', 'not-yours');
  const take = asTransfer(theirs, p.take);
  if (take === null) return refuse(ctx, from, 'offer', 'not-theirs');
  if (
    give.bucks === undefined &&
    give.pets === undefined &&
    take.bucks === undefined &&
    take.pets === undefined
  )
    return refuse(ctx, from, 'offer', 'empty');
  if (applyTransfer(mine, theirs, give, take) === null) return refuse(ctx, from, 'offer', 'short');
  // One open offer per sender: a new one replaces (and stales) the last.
  for (const [id, open] of collection.offers) if (open.from === from) collection.offers.delete(id);
  collection.serial += 1;
  const id = collection.serial;
  collection.offers.set(id, { id, from, to, give, take });
  const name = ctx.players.get(from)?.name ?? `p${String(from)}`;
  const text = `${name} offers ${describe(give)} for your ${describe(take)}`;
  collection.offerText[to] = `${text} · Y accepts`;
  collection.dirty[to] = 1;
  ctx.net.send('offered', { offerId: id, from, text }, { to });
}

/**
 * @param ctx The frame context.
 * @param player Who accepted.
 * @param offerId Which offer.
 */
function accept(ctx: GameContext, player: number, offerId: number): void {
  const open = collection.offers.get(offerId);
  if (open?.to !== player) return refuse(ctx, player, 'accept', 'stale');
  const from = open.from;
  if (collection.busy[from] === 1 || collection.busy[player] === 1)
    return refuse(ctx, player, 'accept', 'busy');
  const a = docOf(ctx, from);
  const b = docOf(ctx, player);
  if (a === null || b === null || applyTransfer(a, b, open.give, open.take) === null) {
    collection.offers.delete(offerId);
    return refuse(ctx, player, 'accept', 'stale');
  }
  collection.offers.delete(offerId);
  collection.offerText[player] = '';
  collection.busy[from] = 1;
  collection.busy[player] = 1;
  const exchange = ctx.data.exchange(from, player, open.give, open.take);
  collection.inFlight.set(exchange, { a: from, b: player });
}

/**
 * The `trade` system.
 *
 * @param ctx The frame context.
 */
export function trade(ctx: GameContext): void {
  const results = ctx.data.results();
  for (let i = 0; i < results.length; i += 1) {
    const r = results[i];
    const pair = collection.inFlight.get(r.id);
    if (pair === undefined) continue;
    collection.inFlight.delete(r.id);
    for (const seat of [pair.a, pair.b]) {
      collection.busy[seat] = 0;
      collection.dirty[seat] = 1;
      ctx.net.send('trade', { ok: r.ok, reason: r.reason }, { to: seat });
    }
  }
  const offers = ctx.net.messages(Offer);
  for (let i = 0; i < offers.length; i += 1) offer(ctx, offers[i].player, offers[i].payload);
  const accepts = ctx.net.messages(Accept);
  for (let i = 0; i < accepts.length; i += 1)
    accept(ctx, accepts[i].player, accepts[i].payload.offerId);
}
