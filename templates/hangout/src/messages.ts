/**
 * The messages, declared once with the game's own checks. A payload that
 * fails its check never reaches a system: the SDK drops it and counts it in
 * `ctx.net.stats.dropped`.
 *
 * Up from a page: `chat` `{ text }`, `cosmetic` `{ color }`, `sit` `null`.
 * Down from the authority: `house` `{ house }` to the player who just moved
 * in, and `chat` `{ player, name, text }` to everyone.
 */
import { defineMessage, hasKeys } from 'gameable';

/** A payload that is exactly `null`: the message is the whole meaning. */
const isNull = (p: unknown): p is null => p === null;

/**
 * A chat line. Up from a page it is `{ text }`; the authority echoes it to
 * everyone as `{ player, name, text }`, with the name the room knows, never
 * the one a page claims.
 */
export interface ChatPayload {
  /** The line, as typed (up) or cleaned and capped (down). */
  text: string;
  /** The sender's seat; the authority fills it in. */
  player?: number;
  /** The sender's display name; the authority fills it in. */
  name?: string;
}

const hasText = hasKeys('text');
/** Chat, both ways. 512 bytes holds a capped line and a name in any script. */
export const Chat = defineMessage(
  'chat',
  (p): p is ChatPayload =>
    hasText(p) &&
    typeof p.text === 'string' &&
    (!('name' in p) || typeof p.name === 'string') &&
    (!('player' in p) || Number.isInteger(p.player)),
  { maxBytes: 512 },
);

/** `#rrggbb`, nothing else. */
const HEX = /^#[0-9a-fA-F]{6}$/;
const hasColor = hasKeys('color');
/** Keys 1-6: wear this colour. Everyone sees it, on the sender's character. */
export const Cosmetic = defineMessage(
  'cosmetic',
  (p): p is { color: string } => hasColor(p) && typeof p.color === 'string' && HEX.test(p.color),
  { maxBytes: 32 },
);

/** F: sit on the bench in reach, or stand up from it. */
export const Sit = defineMessage('sit', isNull, { maxBytes: 8 });

const hasHouse = hasKeys('house');
/** Down only: the house this player lives in, sent once when they move in. */
export const HouseSlot = defineMessage(
  'house',
  (p): p is { house: number } => hasHouse(p) && Number.isInteger(p.house),
  { maxBytes: 32 },
);
