/**
 * Where a page finds its room server. The rule lives here, beside the rest of
 * the page boot, so a page can ask without loading the room server client;
 * `gameable/rooms/client` re-exports it.
 */

/**
 * Hosts a page is served from in local development, where `?rooms=` is
 * honoured: exactly these three. Not `*.localhost`, and nothing that only
 * starts with one of them (`localhost.evil.com`, `127.0.0.1.nip.io`).
 */
const LOCAL_HOST = /^(localhost|127\.0\.0\.1|\[::1\])$/;

/**
 * @param url An `http(s)://` or `ws(s)://` address.
 * @returns It with `http` mapped to `ws` and `https` to `wss`.
 */
function asSocketUrl(url: URL): string {
  if (url.protocol === 'https:') url.protocol = 'wss:';
  else if (url.protocol === 'http:') url.protocol = 'ws:';
  return url.href;
}

/**
 * The room server a page talks to: `<page origin>/services/rooms/`, with
 * https mapped to wss (http to ws). On a page served from a local host
 * (exactly `localhost`, `127.0.0.1` or `[::1]`) a `?rooms=<url>` query
 * parameter points it elsewhere, for local development against `gameable
 * serve`; elsewhere `?rooms=` is ignored, so a shared link cannot send a
 * player's input to a server the game did not choose.
 *
 * @param href The page's address (`location.href`).
 * @returns The room server's address.
 * @throws {TypeError} When `href`, or a local page's `?rooms=`, is not a URL.
 *
 * @example
 * ```ts
 * import { roomsEndpoint } from 'gameable/net/page';
 *
 * roomsEndpoint('https://play.example/mystery/?room=KQTX'); // 'wss://play.example/services/rooms/'
 * roomsEndpoint('http://localhost:5173/?rooms=http://localhost:8790'); // 'ws://localhost:8790/'
 * ```
 */
export function roomsEndpoint(href: string): string {
  const page = new URL(href);
  const override = page.searchParams.get('rooms');
  if (override !== null && override !== '' && LOCAL_HOST.test(page.hostname)) {
    return asSocketUrl(new URL(override));
  }
  return asSocketUrl(new URL('/services/rooms/', page.origin));
}
