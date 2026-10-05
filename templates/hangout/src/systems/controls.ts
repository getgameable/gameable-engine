/**
 * The client's half: keys become messages to the authority. F is `sit`
 * (sit down at a bench, or stand up); 1-6 wear a colour from the palette.
 * E (doors, cars) and WASD are read by the authority from this player's own
 * input, and chat is typed into the page (`src/chatPrompt.ts`).
 */
import type { GameContext } from 'gameable';

import { Cosmetic, Sit } from '../messages';

/** What keys 1-6 wear, in order. */
export const PALETTE = ['#e85d4a', '#f2b33d', '#5cc46f', '#4aa3e8', '#9b6bea', '#f2f2f4'] as const;

const KEYS = ['Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5', 'Digit6'] as const;

/** One payload per palette entry, made once. */
const WEAR = PALETTE.map((color) => ({ color }));

/**
 * The `controls` system.
 *
 * @param ctx The frame context.
 */
export function controls(ctx: GameContext): void {
  if (ctx.input.pressed('KeyF')) ctx.net.send(Sit, null);
  for (let i = 0; i < KEYS.length; i += 1) {
    if (ctx.input.pressed(KEYS[i])) ctx.net.send(Cosmetic, WEAR[i]);
  }
}
