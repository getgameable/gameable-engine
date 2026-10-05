/**
 * The numbers the guest and the room's wire protocol must agree on, defined
 * once. `gameable/net`'s protocol imports them from `gameable/sdk/wire`
 * (a subpath with no other imports), so a guest's `ctx.net.send` check and the
 * server's frame check can never disagree.
 */

/**
 * The sender id of a message from the authority itself. Room seats start at
 * 0, so the authority is not 0: this is past every player id and still a
 * `u32` (the WIT's `message-event.player`). Keep ids unsigned: in an
 * `Int32Array` this reads back as -1.
 *
 * @example
 * ```ts
 * import { AUTHORITY_SENDER } from 'gameable';
 *
 * const fromServer = (from: number): boolean => from === AUTHORITY_SENDER;
 * ```
 */
export const AUTHORITY_SENDER = 0xffffffff;

/** The largest `net.maxPlayers` honoured; the server's player-id ceiling. */
export const MAX_PLAYER_ID = 4096;

/** The largest message payload, in UTF-8 bytes of its JSON, on `ctx.net.send` and on the wire. */
export const MAX_PAYLOAD_BYTES = 2048;

/**
 * The prefix of the message names the engine keeps for itself. A game cannot
 * `defineMessage` or send one, and a room drops one a client sends.
 *
 * @example
 * ```ts
 * import { RESERVED_MESSAGE_PREFIX } from 'gameable/sdk/wire';
 *
 * const ours = (name: string): boolean => name.startsWith(RESERVED_MESSAGE_PREFIX);
 * ```
 */
export const RESERVED_MESSAGE_PREFIX = 'aos:';

/**
 * The reserved message `ctx.net.setPhase` sends from the authority, its
 * payload the phase word as a JSON string. The room server reads it, lists
 * the phase, and never forwards it to a player.
 *
 * @example
 * ```ts
 * import { PHASE_MESSAGE } from 'gameable/sdk/wire';
 *
 * const isPhase = (send: { name: string }): boolean => send.name === PHASE_MESSAGE;
 * ```
 */
export const PHASE_MESSAGE = 'aos:phase';

/** The longest phase word, in characters. */
export const MAX_PHASE_CHARS = 32;

/**
 * A phase word: 1 to {@link MAX_PHASE_CHARS} ASCII letters, digits or dashes.
 * Allocates nothing.
 *
 * @param word A candidate.
 * @returns True for a word `ctx.net.setPhase` sends and a room lists.
 *
 * @example
 * ```ts
 * import { isPhaseWord } from 'gameable/sdk/wire';
 *
 * isPhaseWord('round-2'); // true
 * isPhaseWord('two words'); // false
 * ```
 */
export function isPhaseWord(word: unknown): word is string {
  if (typeof word !== 'string' || word.length === 0 || word.length > MAX_PHASE_CHARS) return false;
  for (let i = 0; i < word.length; i += 1) {
    const c = word.charCodeAt(i);
    const ok =
      c === 0x2d ||
      (c >= 0x30 && c <= 0x39) ||
      (c >= 0x41 && c <= 0x5a) ||
      (c >= 0x61 && c <= 0x7a);
    if (!ok) return false;
  }
  return true;
}
