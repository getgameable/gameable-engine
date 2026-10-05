/**
 * Every player's HUD, written by the authority through their own handle:
 * their house, how many are on the street, what E or F would do, and the
 * last three chat lines. A HUD is rebuilt only on the ticks one of those
 * changed (a number per seat), so a quiet tick allocates nothing. The page
 * draws every value with `textContent`, never as HTML.
 */
import type { GameContext } from 'gameable';

import { CHAT_LINES, chatLog } from './chat';
import { MAX_PLAYERS, residents } from './residents';
import { chatState } from './systems/chat';

/** What each `PROMPT_*` says. */
const PROMPTS = [
  '',
  'E: open the door',
  'E: close the door',
  'E: drive',
  'WASD drive · E: get out',
  'F: sit',
  'F or WASD: stand up',
];

/** The signature each seat was last drawn with; -1 for never. */
const drawn = new Float64Array(MAX_PLAYERS);

/** Forget what was drawn. Call from `defineGame({ init })`. */
export function resetHud(): void {
  drawn.fill(-1);
}

/**
 * @param seat A seat with a body.
 * @returns The numbers its HUD depends on, packed into one.
 */
function signature(seat: number): number {
  return (
    ((chatState.revision * 16 + residents.count) * 8 + residents.house[seat] + 1) * 8 +
    residents.prompt[seat]
  );
}

/**
 * @param seat The player.
 * @returns Their HUD model.
 */
function model(seat: number): Record<string, unknown> {
  const text: Record<string, string> = {
    house: String(residents.house[seat] + 1),
    street: `${String(residents.count)}/${String(MAX_PLAYERS)}`,
  };
  for (let i = 0; i < CHAT_LINES; i += 1) {
    if (chatLog.lines[i] !== '') text[`chat ${String(i + 1)}`] = chatLog.lines[i];
  }
  return { text, message: PROMPTS[residents.prompt[seat]] ?? '' };
}

/**
 * The `streetHud` system.
 *
 * @param ctx The frame context.
 */
export function streetHud(ctx: GameContext): void {
  for (let seat = 0; seat < MAX_PLAYERS; seat += 1) {
    if (residents.entity[seat] === 0) {
      drawn[seat] = -1;
      continue;
    }
    const sig = signature(seat);
    if (drawn[seat] === sig) continue;
    drawn[seat] = sig;
    ctx.players.get(seat)?.hud.set(model(seat));
  }
}
