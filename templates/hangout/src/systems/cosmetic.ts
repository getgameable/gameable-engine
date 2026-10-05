/**
 * Cosmetics on the authority: a `cosmetic` `{ color }` message paints the
 * sender's character, as one `set-material-param`. That command is world
 * state, so every page sees it, and the room hands it to anyone who joins
 * later. Kept in `residents.color` for as long as the player stays, and in
 * the player's saved document (`ctx.data`, `{ color }`), so `arrive` puts it
 * back on their next visit.
 */
import type { GameContext } from 'gameable';

import { Cosmetic } from '../messages';
import { tint } from '../prefabs';
import { residents } from '../residents';

/**
 * @param hex Two hex digits.
 * @returns The sRGB channel as linear light, 0..1.
 */
function linear(hex: string): number {
  return Math.pow(parseInt(hex, 16) / 255, 2.2);
}

/** A saved colour: `#rrggbb`, as the `cosmetic` message allows. */
const SAVED = /^#[0-9a-f]{6}$/;

/**
 * Paint a seat's character and remember the colour for as long as they stay.
 *
 * @param seat The seat.
 * @param entity Their character.
 * @param color `#rrggbb`, lower case.
 */
export function wear(seat: number, entity: number, color: string): void {
  residents.color[seat] = color;
  tint(entity, linear(color.slice(1, 3)), linear(color.slice(3, 5)), linear(color.slice(5, 7)));
}

/**
 * @param data A player's saved document (`ctx.players.get(seat).data`).
 * @returns The colour it keeps, or `''` for none.
 */
export function savedColor(data: unknown): string {
  if (typeof data !== 'object' || data === null) return '';
  const color = (data as { color?: unknown }).color;
  return typeof color === 'string' && SAVED.test(color) ? color : '';
}

/**
 * The `cosmetic` system.
 *
 * @param ctx The frame context.
 */
export function cosmetic(ctx: GameContext): void {
  const asks = ctx.net.messages(Cosmetic);
  for (let i = 0; i < asks.length; i += 1) {
    const seat = asks[i].player;
    const entity = residents.entity[seat] ?? 0;
    if (entity === 0) continue;
    const color = asks[i].payload.color.toLowerCase();
    if (color === residents.color[seat]) continue;
    wear(seat, entity, color);
    // Kept in the player's document, beside whatever else it holds, for their next visit.
    const doc = ctx.players.get(seat)?.data;
    ctx.data.save(seat, { ...(typeof doc === 'object' && doc !== null ? doc : {}), color });
  }
}
