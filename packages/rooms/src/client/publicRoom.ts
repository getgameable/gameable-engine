/**
 * One entry of the lobby's list, checked: the lobby forwards the matchmaker's
 * listing, and a page shows only what our rooms publish.
 */
import type { PublicRoom } from '@gameable/net/page';

/** The longest code or phase a page is shown; anything longer is not one of ours. */
const MAX_TEXT = 32;

/**
 * @param value A field from the server.
 * @returns It, when it is a short string.
 */
function text(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_TEXT ? value : null;
}

/**
 * @param value A field from the server.
 * @returns It, when it is a whole number from 0.
 */
function count(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;
}

/**
 * Read one lobby entry (`{ roomId, name, private, metadata: { game, code,
 * players, maxPlayers, phase? } }`) as a page's room.
 *
 * @param entry The entry as the lobby sent it.
 * @param game The game the page asked for.
 * @returns The room, or null for an entry of another game, a private one, or
 *   one whose metadata is not ours.
 *
 * @example
 * ```ts
 * import { publicRoom } from 'gameable/rooms/client';
 *
 * const meta = { game: 'party', code: 'KQTX', players: 1, maxPlayers: 4 };
 * publicRoom({ roomId: 'KQTX', name: 'party', metadata: meta }, 'party');
 * // { code: 'KQTX', players: 1, maxPlayers: 4, phase: null }
 * ```
 */
export function publicRoom(entry: unknown, game: string): PublicRoom | null {
  if (typeof entry !== 'object' || entry === null) return null;
  const { name, metadata } = entry as { name?: unknown; metadata?: unknown };
  if ((entry as { private?: unknown }).private === true) return null;
  if (name !== game || typeof metadata !== 'object' || metadata === null) return null;
  const meta = metadata as Record<string, unknown>;
  const code = text(meta.code);
  const players = count(meta.players);
  const maxPlayers = count(meta.maxPlayers);
  if (meta.game !== game || code === null || players === null || maxPlayers === null) return null;
  return { code, players, maxPlayers, phase: text(meta.phase) };
}
