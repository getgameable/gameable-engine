/**
 * The checks every store makes before it writes: the size cap, the JSON rule,
 * and running an exchange's `apply` so a throw is a refusal, never a crash.
 */
import { MAX_DOC_BYTES, type ExchangeApply } from './types.js';

const encoder = new TextEncoder();

/** UTF-8 bytes of `text`, without encoding it when its length already decides. */
function tooBig(text: string): boolean {
  if (text.length > MAX_DOC_BYTES) return true;
  if (text.length * 3 <= MAX_DOC_BYTES) return false; // a UTF-16 unit is at most 3 UTF-8 bytes
  return encoder.encode(text).length > MAX_DOC_BYTES;
}

/** True when any string or key in the value holds U+0000, which Postgres `jsonb` cannot store. */
function holdsNul(value: unknown): boolean {
  if (typeof value === 'string') return value.includes('\0');
  if (value === null || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some(holdsNul);
  return Object.entries(value).some(([key, v]) => key.includes('\0') || holdsNul(v));
}

/** Why `text` may not be stored, or `null` when it may. */
export function docRefusal(text: string): 'size' | 'invalid' | null {
  if (tooBig(text)) return 'size';
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return 'invalid';
  }
  return holdsNul(value) ? 'invalid' : null;
}

/** The two new documents, or why the exchange stops: `apply` said no or threw, or a result may not be stored. */
export function runApply(
  apply: ExchangeApply,
  docA: string | null,
  docB: string | null,
): { a: string; b: string } | 'refused' | 'size' | 'invalid' {
  let next: { a: string; b: string } | null;
  try {
    next = apply(docA, docB);
  } catch {
    return 'refused';
  }
  if (next === null || typeof next.a !== 'string' || typeof next.b !== 'string') return 'refused';
  return docRefusal(next.a) ?? docRefusal(next.b) ?? next;
}
