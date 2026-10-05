/**
 * The messages a player sends up, declared once with the game's own checks.
 * A payload that fails its check never reaches a system: the SDK drops it and
 * counts it in `ctx.net.stats.dropped`.
 *
 * What the authority sends down (`round`, `tagged`, `vote`, `vote-over`,
 * `round-over`) is listed in the README; `chat` goes both ways.
 */
import { defineMessage, hasKeys } from 'gameable';

/** A payload that is exactly `null`: the message is the whole meaning. */
const isNull = (p: unknown): p is null => p === null;

/** R in the lobby: toggle this player's ready. */
export const Ready = defineMessage('ready', isNull, { maxBytes: 8 });

/** G: the host starts the round now, ready or not (three players or more). */
export const Start = defineMessage('start', isNull, { maxBytes: 8 });

const hasFor = hasKeys('for');
/** 1-6 during a vote: the seat this player thinks is "it" (key 1 is seat 0). */
export const Vote = defineMessage(
  'vote',
  (p): p is { for: number } => hasFor(p) && Number.isInteger(p.for) && (p.for as number) >= 0,
  { maxBytes: 64 },
);

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
