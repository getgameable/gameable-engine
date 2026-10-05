/**
 * What a page's address asks for: Play Solo, a room by its code, a new room,
 * or a quick match.
 */

/**
 * The room a page asked for with `?room=`:
 *
 * - `solo`: no `?room=` (or an empty one). The authority runs in the page.
 * - `join`: `?room=CODE`, that room on the room server.
 * - `new`: `?room=new`, a fresh room whose code the page then shows.
 * - `quick`: `?room=quick`, any open room of this game, or a new one.
 *
 * @example
 * ```ts
 * import type { RoomMode } from 'gameable/net/page';
 * const online = (mode: RoomMode): boolean => mode.kind !== 'solo';
 * ```
 */
export type RoomMode =
  | { readonly kind: 'solo' }
  | { readonly kind: 'join'; readonly code: string }
  | { readonly kind: 'new' }
  | { readonly kind: 'quick' };

/**
 * Read the page's `?room=`. `new` and `quick` are words in any case; anything
 * else is a room code, trimmed and upper-cased.
 *
 * @param search The page's query (`location.search`), or its parameters.
 * @returns The room mode.
 *
 * @example
 * ```ts
 * import { roomMode } from 'gameable/net/page';
 *
 * roomMode('');            // { kind: 'solo' }
 * roomMode('?room=kqtx');  // { kind: 'join', code: 'KQTX' }
 * roomMode('?room=new');   // { kind: 'new' }
 * roomMode('?room=quick'); // { kind: 'quick' }
 * ```
 */
export function roomMode(search: string | URLSearchParams): RoomMode {
  const params = typeof search === 'string' ? new URLSearchParams(search) : search;
  const asked = params.get('room')?.trim() ?? '';
  if (asked === '') return { kind: 'solo' };
  const word = asked.toLowerCase();
  if (word === 'new') return { kind: 'new' };
  if (word === 'quick') return { kind: 'quick' };
  return { kind: 'join', code: asked.toUpperCase() };
}
