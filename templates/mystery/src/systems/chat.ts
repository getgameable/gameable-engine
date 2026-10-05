/**
 * Chat on the authority: a line from any player in the room, cleaned and
 * capped, echoed with the name the room knows them by, and kept for the HUDs
 * (`src/hud.ts`).
 *
 * Ghost chat, as in Among Us: while a round runs, a player who is out or
 * watching (`round.ghost`) is heard only by the other ghosts, so a tagged
 * player cannot tell the vote who tagged them. A living player is heard by
 * everyone, and between rounds everyone hears everyone.
 */
import type { GameContext } from 'gameable';

import { CHAT_MAX_CHARS, chatLog, cleanText, ghostLog } from '../chat';
import { nameOf } from '../lobby';
import { Chat } from '../messages';
import { MAX_SEATS, round } from '../round';

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
    const ghost = round.ghost(player);
    const line = `#${String(player + 1)} ${name}${ghost ? ' (ghost)' : ''}: ${text}`;
    ghostLog.push(line);
    round.revision += 1;
    if (!ghost) {
      chatLog.push(line);
      ctx.net.send(Chat, { player, name, text });
      continue;
    }
    for (let to = 0; to < MAX_SEATS; to += 1) {
      if (ctx.players.get(to)?.connected === true && round.ghost(to)) {
        ctx.net.send(Chat, { player, name, text }, { to });
      }
    }
  }
}
