/**
 * The messages a player sends up, declared once with the game's own checks.
 * A payload that fails its check never reaches a system: the SDK drops it and
 * counts it in `ctx.net.stats.dropped`.
 *
 * A trade side names what one player hands over: bucks, and pets by id.
 *
 * What the authority sends down, each to the players it concerns: `deal`
 * (the trade T would offer), `offered` (someone offers you a trade), `trade`
 * (how a trade ended), `refused` (why your message did nothing) and
 * `hatched` (your egg hatched).
 */
import { defineMessage } from 'gameable';

/** One side of a trade: bucks, and pets by id. */
export interface TradeSide {
  bucks?: number;
  pets?: string[];
}

/** The most pets one side of a trade can hold. */
export const MAX_TRADE_PETS = 8;

/** A payload that is exactly `null`: the message is the whole meaning. */
const isNull = (p: unknown): p is null => p === null;

/**
 * @param value Anything.
 * @returns True for a trade side: whole bucks from 0, at most eight pet ids.
 */
export function isSide(value: unknown): value is TradeSide {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const s = value as Record<string, unknown>;
  for (const key of Object.keys(s)) if (key !== 'bucks' && key !== 'pets') return false;
  const bucks = s.bucks;
  if (bucks !== undefined && (typeof bucks !== 'number' || !Number.isInteger(bucks) || bucks < 0))
    return false;
  const pets = s.pets;
  if (pets === undefined) return true;
  return (
    Array.isArray(pets) &&
    pets.length <= MAX_TRADE_PETS &&
    pets.every((id) => typeof id === 'string' && id.length <= 24)
  );
}

/** B: buy an egg, if I have the bucks. */
export const Buy = defineMessage('buy', isNull, { maxBytes: 8 });

/** C: combine four identical pets into one of the next tier (`null`: the first four found). */
export const Combine = defineMessage(
  'combine',
  (p): p is { kind: string; tier: number } | null =>
    p === null ||
    (typeof p === 'object' &&
      typeof (p as { kind?: unknown }).kind === 'string' &&
      Number.isInteger((p as { tier?: unknown }).tier)),
  { maxBytes: 64 },
);

/** T: offer player `to` a trade: I give `give`, I take `take`. */
export const Offer = defineMessage(
  'offer',
  (p): p is { to: number; give: TradeSide; take: TradeSide } =>
    typeof p === 'object' &&
    p !== null &&
    Number.isInteger((p as { to?: unknown }).to) &&
    isSide((p as { give?: unknown }).give) &&
    isSide((p as { take?: unknown }).take),
  { maxBytes: 640 },
);

/** Y: accept the offer with this id. */
export const Accept = defineMessage(
  'accept',
  (p): p is { offerId: number } =>
    typeof p === 'object' && p !== null && Number.isInteger((p as { offerId?: unknown }).offerId),
  { maxBytes: 32 },
);
