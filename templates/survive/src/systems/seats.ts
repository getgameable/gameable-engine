/**
 * A seat that is left or taken starts again with no wood and on its feet. Its
 * nights come from the player's saved document (`{ nightsSurvived }`), or 0.
 * Read from the events, not the seat, because a seat can be left and taken
 * again in one frame. Authority only.
 */
import type { GameContext } from 'gameable';

import { MAX_SEATS, camp } from '../camp';

/**
 * @param data A player's saved document.
 * @returns The nights it keeps, or 0.
 */
export function savedNights(data: unknown): number {
  if (typeof data !== 'object' || data === null) return 0;
  const nights = (data as { nightsSurvived?: unknown }).nightsSurvived;
  return typeof nights === 'number' && Number.isInteger(nights) && nights > 0 ? nights : 0;
}

/**
 * The `seats` system.
 *
 * @param ctx The frame context.
 */
export function seats(ctx: GameContext): void {
  const events = ctx.events;
  for (let i = 0; i < events.length; i += 1) {
    const event = events[i];
    if (event.tag === 'player-joined' || event.tag === 'player-left') {
      const player = event.val.player;
      camp.clearSeat(player);
      if (event.tag === 'player-joined' && player < MAX_SEATS) {
        camp.nightsSurvived[player] = savedNights(ctx.players.get(player)?.data);
      }
    }
  }
}
