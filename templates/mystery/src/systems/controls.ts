/**
 * The client's half: keys become messages to the authority, and being tagged
 * plays a sound on this page only. R is ready, G is the host's start, 1-6
 * vote for that seat. Chat is typed into the page (`src/chatPrompt.ts`), not
 * read here. The role itself arrives in this player's HUD, written by the
 * authority (`src/hud.ts`), so a client never holds the secret for anyone else.
 */
import type { GameContext } from 'gameable';

import { Ready, Start, Vote } from '../messages';

/** Key `n` votes for seat `n - 1`. */
const VOTE_KEYS = ['Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5', 'Digit6'] as const;

/**
 * The `controls` system.
 *
 * @param ctx The frame context.
 */
export function controls(ctx: GameContext): void {
  // Solo runs every system, but there is nobody to send to.
  if (ctx.net.role === 'solo') return;
  if (ctx.input.pressed('KeyR')) ctx.net.send(Ready, null);
  if (ctx.input.pressed('KeyG')) ctx.net.send(Start, null);
  for (let i = 0; i < VOTE_KEYS.length; i += 1) {
    if (ctx.input.pressed(VOTE_KEYS[i])) ctx.net.send(Vote, { for: i });
  }
  const tagged = ctx.net.messages<{ player: number }>('tagged');
  for (let i = 0; i < tagged.length; i += 1) {
    if (tagged[i].payload.player === ctx.net.localPlayer) ctx.audio.play('sfx.tag');
  }
}
