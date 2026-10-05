/**
 * The pets, the eggs and the player document they live in.
 *
 * A player's document is what the room's store keeps for them between visits:
 * `{ bucks, pets: { id, kind, tier }[], eggs: { kind, hatchAt }[] }`. The
 * authority reads it from `ctx.players.get(id).data` and writes it with
 * `ctx.data.save`. Plain functions over plain data: safe in the wasm guest.
 */
import type { Rng } from 'gameable';

/** One pet. `id` is unique to that pet; four of one `kind` and `tier` combine. */
export interface Pet {
  id: string;
  kind: string;
  tier: number;
}

/** One egg. `hatchAt` is `ctx.elapsed` seconds in the room it hatches in. */
export interface Egg {
  kind: string;
  hatchAt: number;
}

/** A player's saved document. */
export interface CollectDoc {
  bucks: number;
  pets: Pet[];
  eggs: Egg[];
}

/** One row of the hatch table: a kind, how often it comes out of an egg, its colour. */
export interface PetKind {
  kind: string;
  /** Relative chance; the table's weights need not add up to anything. */
  weight: number;
  rgb: readonly [number, number, number];
}

/** What an egg hatches into, rarest last. Change the weights to change the odds. */
export const PET_KINDS: readonly PetKind[] = [
  { kind: 'cat', weight: 60, rgb: [0.95, 0.6, 0.25] },
  { kind: 'dog', weight: 30, rgb: [0.55, 0.38, 0.22] },
  { kind: 'unicorn', weight: 9, rgb: [0.9, 0.55, 0.95] },
  { kind: 'dragon', weight: 1, rgb: [0.2, 0.85, 0.35] },
];

/** The total of the table's weights. */
const TOTAL_WEIGHT = PET_KINDS.reduce((sum, row) => sum + row.weight, 0);

/** The one egg the shop sells. */
export const EGG_KIND = 'basic';

/**
 * Draw a pet's kind. Run on the authority only, with `ctx.rng`, so every page
 * sees the same pet and nobody can reroll one.
 *
 * @param rng The authority's seeded random source.
 * @returns A kind from {@link PET_KINDS}, weighted.
 */
export function drawKind(rng: Rng): string {
  let roll = rng.float() * TOTAL_WEIGHT;
  for (const row of PET_KINDS) {
    roll -= row.weight;
    if (roll < 0) return row.kind;
  }
  return PET_KINDS[PET_KINDS.length - 1].kind;
}

/**
 * @param kind A pet kind.
 * @returns Its colour; grey for a kind not in the table.
 */
export function colourOf(kind: string): readonly [number, number, number] {
  for (const row of PET_KINDS) if (row.kind === kind) return row.rgb;
  return [0.6, 0.6, 0.6];
}

/**
 * A fresh pet id, drawn on the authority.
 *
 * @param rng The authority's random source.
 * @returns An id such as `p1x9k2c`.
 */
export function newPetId(rng: Rng): string {
  return `p${rng.uint32().toString(36)}`;
}

/** @returns True for a pet with a string id and kind and a whole tier from 1. */
function isPet(value: unknown): value is Pet {
  if (typeof value !== 'object' || value === null) return false;
  const p = value as Record<string, unknown>;
  return (
    typeof p.id === 'string' &&
    typeof p.kind === 'string' &&
    typeof p.tier === 'number' &&
    Number.isInteger(p.tier) &&
    p.tier >= 1
  );
}

/** @returns True for an egg with a kind and a finite hatch time. */
function isEgg(value: unknown): value is Egg {
  if (typeof value !== 'object' || value === null) return false;
  const e = value as Record<string, unknown>;
  return typeof e.kind === 'string' && typeof e.hatchAt === 'number' && Number.isFinite(e.hatchAt);
}

/**
 * @param value A player's `data`.
 * @returns True when it is a well-formed {@link CollectDoc}.
 */
export function isCollectDoc(value: unknown): value is CollectDoc {
  if (typeof value !== 'object' || value === null) return false;
  const d = value as Record<string, unknown>;
  return (
    typeof d.bucks === 'number' &&
    Number.isFinite(d.bucks) &&
    d.bucks >= 0 &&
    Array.isArray(d.pets) &&
    d.pets.every(isPet) &&
    Array.isArray(d.eggs) &&
    d.eggs.every(isEgg)
  );
}

/**
 * @param bucks What a new player starts with.
 * @returns An empty document.
 */
export function emptyDoc(bucks: number): CollectDoc {
  return { bucks, pets: [], eggs: [] };
}
