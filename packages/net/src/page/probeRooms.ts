/**
 * Does this page have a room server? A solo page asks once, at load, before
 * it offers "Play with friends": a page hosted where nothing serves rooms
 * (the docs site) would otherwise send a friend to a dead link.
 */

/** How long {@link probeRooms} waits by default, in milliseconds. */
export const PROBE_TIMEOUT_MS = 1500;

/** Options for {@link probeRooms}; the defaults are the browser's own. */
export interface ProbeRoomsOptions {
  /** Give up after this many ms. Default {@link PROBE_TIMEOUT_MS}. */
  readonly timeoutMs?: number;
  /** Default `globalThis.fetch`. */
  readonly fetch?: typeof fetch;
  /** The page's origin. Default `location.origin`. */
  readonly origin?: string;
}

/**
 * The room server's health address for a rooms endpoint.
 *
 * @param endpoint A `roomsEndpoint(...)` address (`ws(s)://.../`).
 * @returns Its `/health` over http(s).
 *
 * @example
 * ```ts
 * import { roomsHealthUrl } from 'gameable/net/page';
 * roomsHealthUrl('wss://play.example/services/rooms/'); // 'https://play.example/services/rooms/health'
 * ```
 */
export function roomsHealthUrl(endpoint: string): string {
  const url = new URL('health', endpoint);
  if (url.protocol === 'wss:') url.protocol = 'https:';
  else if (url.protocol === 'ws:') url.protocol = 'http:';
  return url.href;
}

/**
 * Ask the room server's `/health`, with a short timeout.
 *
 * Same-origin (the hosted case, `/services/rooms/`) the answer must be the
 * room server's health JSON with `ok: true`: a 404 from a host with no rooms
 * route, or a dev server's page, is "no". Cross-origin (a local
 * `?rooms=` dev server) the request is `no-cors`, so its answer is opaque, and
 * any answer at all is "yes"; a refused connection or the timeout is "no".
 *
 * @param endpoint The page's `roomsEndpoint(location.href)`.
 * @param options Timeout and browser stand-ins.
 * @returns True when a room server answered in time. Never rejects.
 *
 * @example
 * ```ts
 * import { probeRooms, roomsEndpoint } from 'gameable/net/page';
 * const friends = await probeRooms(roomsEndpoint(location.href)); // false on a host without rooms
 * ```
 */
export async function probeRooms(
  endpoint: string,
  options: ProbeRoomsOptions = {},
): Promise<boolean> {
  const doFetch = options.fetch ?? globalThis.fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, options.timeoutMs ?? PROBE_TIMEOUT_MS);
  try {
    const url = roomsHealthUrl(endpoint);
    const origin = options.origin ?? globalThis.location.origin;
    const same = new URL(url).origin === origin;
    const answer = await doFetch(url, {
      mode: same ? 'same-origin' : 'no-cors',
      cache: 'no-store',
      signal: controller.signal,
    });
    if (answer.type === 'opaque') return true;
    if (!answer.ok) return false;
    // A dev server answers every path with its page; only a room server says ok.
    const health = (await answer.json()) as { ok?: unknown } | null;
    return health?.ok === true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}
