/**
 * `applyTransfer` — the one rule an exchange follows, run by the guest
 * (`ctx.data`) and by the room's store alike, so both end on the same two
 * documents.
 */

/** A player document as a transfer reads it: a plain object. */
export type TransferDoc = Record<string, unknown>;

/**
 * @param value Anything.
 * @returns True for a plain object (not an array, not null).
 */
function isDoc(value: unknown): value is TransferDoc {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * @param value A JSON value.
 * @returns It as JSON with every object's keys sorted, so two equal values
 *   compare equal whatever order their keys came in (Postgres `jsonb` reorders them).
 */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    const keys = Object.keys(value).sort();
    const doc = value as TransferDoc;
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(doc[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/**
 * Where an item sits in a list: by value, so an object item such as
 * `{ id: 'p1', kind: 'cat' }` matches its copy from another parse.
 *
 * @param list The giver's items.
 * @param item The item to find.
 * @returns Its index, or -1.
 */
function indexOfItem(list: readonly unknown[], item: unknown): number {
  if (typeof item !== 'object' || item === null) return list.indexOf(item);
  const want = canonical(item);
  for (let i = 0; i < list.length; i += 1) if (canonical(list[i]) === want) return i;
  return -1;
}

/**
 * Move every field of `what` from `from` to `to`, in place.
 *
 * @param from The giving side, a copy.
 * @param to The receiving side, a copy.
 * @param what Numbers to move (at least 0), or lists of items to move.
 * @returns False when the giver lacks something, or a field is neither.
 */
function move(from: TransferDoc, to: TransferDoc, what: TransferDoc): boolean {
  for (const [field, amount] of Object.entries(what)) {
    if (typeof amount === 'number') {
      const has = from[field] ?? 0;
      if (!Number.isFinite(amount) || amount < 0 || typeof has !== 'number' || has < amount)
        return false;
      const gets = to[field] ?? 0;
      if (typeof gets !== 'number') return false;
      from[field] = has - amount;
      to[field] = gets + amount;
    } else if (Array.isArray(amount)) {
      const has = from[field] ?? [];
      const gets = to[field] ?? [];
      if (!Array.isArray(has) || !Array.isArray(gets)) return false;
      const left = [...(has as unknown[])];
      const items = amount as unknown[];
      for (const item of items) {
        const at = indexOfItem(left, item);
        if (at < 0) return false;
        left.splice(at, 1);
      }
      from[field] = left;
      to[field] = [...(gets as unknown[]), ...items];
    } else {
      return false;
    }
  }
  return true;
}

/**
 * Trade between two player documents: `a` gives `b` everything in `give`,
 * and takes from `b` everything in `take`. A number field moves that amount
 * (the giver must have at least that much); a list field moves those items
 * (the giver must hold each one; an object item matches by value, whatever
 * its key order). A missing document counts as `{}`.
 *
 * @param docA Player a's document, or null.
 * @param docB Player b's document, or null.
 * @param give What a gives b, such as `{ coins: 5 }`.
 * @param take What a takes from b, such as `{ owned: ['gem'] }`.
 * @returns Both new documents (the inputs are untouched), or null when the trade is impossible.
 *
 * @example
 * ```ts
 * import { applyTransfer } from 'gameable';
 *
 * applyTransfer({ coins: 10 }, { owned: ['gem'] }, { coins: 4 }, { owned: ['gem'] });
 * // { a: { coins: 6, owned: ['gem'] }, b: { owned: [], coins: 4 } }
 * ```
 */
export function applyTransfer(
  docA: unknown,
  docB: unknown,
  give: unknown,
  take: unknown,
): { a: TransferDoc; b: TransferDoc } | null {
  const a = docA ?? {};
  const b = docB ?? {};
  if (!isDoc(a) || !isDoc(b) || !isDoc(give) || !isDoc(take)) return null;
  const nextA = { ...a };
  const nextB = { ...b };
  if (!move(nextA, nextB, give) || !move(nextB, nextA, take)) return null;
  return { a: nextA, b: nextB };
}
