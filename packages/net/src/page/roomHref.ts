/**
 * The page addresses a room page shares and resumes from.
 */
import type { RoomMode } from './roomMode.js';

/** The slice of `window` that {@link rememberRoom} writes to. */
export interface PageHistory {
  readonly location: { readonly href: string };
  readonly history: Pick<History, 'replaceState'>;
}

/**
 * The page's address with `?room=CODE`, every other parameter kept (a local
 * page's `?rooms=` too, so a copied link reaches the same dev server).
 *
 * @param href The page's address.
 * @param code The room code.
 * @returns The address that joins that room.
 *
 * @example
 * ```ts
 * import { roomHref } from 'gameable/net/page';
 * roomHref('https://play.example/g/?room=new', 'KQTX'); // 'https://play.example/g/?room=KQTX'
 * ```
 */
export function roomHref(href: string, code: string): string {
  const url = new URL(href);
  url.searchParams.set('room', code);
  return url.href;
}

/**
 * The address a solo page goes to for "Play with friends": `?room=new`.
 *
 * @param href The page's address.
 * @returns The same page, asking for a new room.
 *
 * @example
 * ```ts
 * import { friendsHref } from 'gameable/net/page';
 * friendsHref('https://play.example/g/'); // 'https://play.example/g/?room=new'
 * ```
 */
export function friendsHref(href: string): string {
  return roomHref(href, 'new');
}

/**
 * After a new room or a quick match, write `?room=CODE` into the address with
 * `history.replaceState`, so a reload resumes the seat (the seat token is
 * kept per code) and a copied address brings a friend to the same room. A
 * join by code, Play Solo, and an address that already names the code are
 * left alone.
 *
 * @param mode The mode the page booted in.
 * @param code The joined room's code (`net.room`), or null before the welcome.
 * @param page `window`, or a stand-in.
 * @returns True when the address was rewritten.
 *
 * @example
 * ```ts
 * import { rememberRoom, roomMode } from 'gameable/net/page';
 * rememberRoom(roomMode('?room=quick'), 'KQTX', window); // the address now ends ?room=KQTX
 * ```
 */
export function rememberRoom(mode: RoomMode, code: string | null, page: PageHistory): boolean {
  if (code === null || (mode.kind !== 'new' && mode.kind !== 'quick')) return false;
  const next = roomHref(page.location.href, code);
  if (next === page.location.href) return false;
  page.history.replaceState(null, '', next);
  return true;
}
