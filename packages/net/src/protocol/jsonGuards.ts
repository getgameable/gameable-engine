/**
 * Type guards for parsed JSON: the field checks the text frames are built on.
 */
import type { PlayerSummary } from './types.js';

/** A parsed JSON object. */
export type Json = Record<string, unknown>;

/**
 * Whether JSON text nests arrays and objects no deeper than `limit`, found by
 * one pass over the characters that skips string contents. Cheap enough to run
 * before `JSON.parse`, so a deeply nested frame is never parsed at all.
 *
 * @param text - Unparsed JSON text.
 * @param limit - The deepest nesting allowed.
 * @returns False as soon as the nesting passes `limit`.
 */
export function depthWithin(text: string, limit: number): boolean {
  let depth = 0;
  let inString = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text.charCodeAt(i);
    if (inString) {
      if (c === 0x5c)
        i += 1; // a backslash: skip the escaped character
      else if (c === 0x22) inString = false;
    } else if (c === 0x22) inString = true;
    else if (c === 0x5b || c === 0x7b) {
      depth += 1;
      if (depth > limit) return false;
    } else if (c === 0x5d || c === 0x7d) depth -= 1;
  }
  return true;
}

/**
 * Whether a parsed value is a plain object.
 *
 * @param value - A parsed JSON value.
 * @returns True for an object that is neither null nor an array.
 */
export function isObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Whether a parsed value is a finite number.
 *
 * @param value - A parsed JSON value.
 * @returns True for a number other than NaN and the infinities.
 */
export function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * Whether a parsed value is a safe integer.
 *
 * @param value - A parsed JSON value.
 * @returns True for an integer JavaScript represents exactly.
 */
export function isInt(value: unknown): value is number {
  return Number.isSafeInteger(value);
}

/**
 * Whether a parsed value can be an id, a frame or an ack.
 *
 * @param value - A parsed JSON value.
 * @returns True for a non-negative safe integer.
 */
export function isId(value: unknown): value is number {
  return isInt(value) && value >= 0;
}

/**
 * Whether a parsed value is a room's player list.
 *
 * @param value - A parsed JSON value.
 * @returns True for an array of `{ id, name, connected }`.
 */
export function isPlayers(value: unknown): value is PlayerSummary[] {
  return (
    Array.isArray(value) &&
    value.every(
      (p) =>
        isObject(p) && isId(p.id) && typeof p.name === 'string' && typeof p.connected === 'boolean',
    )
  );
}
