/**
 * Reading `ctx.rules`: every tuning number lives in `src/game.ts`'s `rules`
 * block, and a system reads it through here with the same default.
 */

/**
 * A rule read as a number, with a fallback.
 *
 * @param value The rule value.
 * @param fallback What to use when it is missing or not a number.
 * @returns The number.
 */
export function num(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}
