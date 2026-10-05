/**
 * Chat on the authority: a line from anyone on the street, cleaned and
 * capped (`src/chat.ts`), echoed to everyone with the name the room knows
 * them by, and kept for the HUDs.
 */
import type { GameContext } from 'gameable';

import { CHAT_MAX_CHARS, chatLog, cleanText } from '../chat';
import { Chat } from '../messages';
import { nameOf } from '../residents';

/** Bumped on every line, so the HUD knows to redraw. */
export const chatState = { revision: 0 };

/**
 * The `chat` system.
 *
 * @param ctx The frame context.
 */
export function chat(ctx: GameContext): void {
  const lines = ctx.net.messages(Chat);
  for (let i = 0; i < lines.length; i += 1) {
    const player = lines[i].player;
    if (ctx.players.get(player)?.connected !== true) continue;
    const text = cleanText(lines[i].payload.text, CHAT_MAX_CHARS);
    if (text === '') continue;
    const name = nameOf(ctx, player);
    chatLog.push(`${name}: ${text}`);
    chatState.revision += 1;
    ctx.net.send(Chat, { player, name, text });
  }
}
