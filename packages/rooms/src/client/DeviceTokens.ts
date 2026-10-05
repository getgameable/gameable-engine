/**
 * `DeviceTokens` — the device token a room server handed this browser
 * (`IDENTITY_TYPE`), kept in `localStorage`: it names the device, not the
 * seat, so every tab and every reload sends the same one, and the player
 * keeps the same id (and saved data) across rooms. Seat tokens stay in each
 * tab's `sessionStorage` (`SeatTokens`).
 */
import type { SeatStorage } from './SeatTokens.js';

const SHAPE = /^device\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}$/;

/** @returns This browser's `localStorage`, or null where there is none (Node) or it is blocked. */
function browserStorage(): SeatStorage | null {
  try {
    return (globalThis as { localStorage?: SeatStorage }).localStorage ?? null;
  } catch {
    return null; // a sandboxed frame throws on the getter
  }
}

/**
 * @param url The room server, `ws(s)://` or `http(s)://`.
 * @returns Its origin as `http(s)://host[:port]`.
 */
function serverOrigin(url: string): string {
  try {
    return new URL(url.replace(/^ws(s?):/i, 'http$1:')).origin;
  } catch {
    return url; // not a URL: the join fails anyway, with the SDK's own error
  }
}

/**
 * The device token for one room server, under
 * `aos.identity.<the server's origin>` (a token is signed by that server's
 * secret, and means nothing to another). Storage failures are ignored:
 * without a token the server mints a new one, and the player is a new device.
 *
 * @example
 * ```ts
 * import { DeviceTokens } from 'gameable/rooms/client';
 *
 * const tokens = new DeviceTokens('wss://play.example/services/rooms/');
 * tokens.key; // 'aos.identity.https://play.example'
 * const token = tokens.load(); // null on first contact
 * ```
 */
export class DeviceTokens {
  /** The storage key. */
  readonly key: string;
  private readonly storage: SeatStorage | null;

  /**
   * @param url The room server.
   * @param storage Where to keep it. Default `localStorage`; null keeps none.
   */
  constructor(url: string, storage?: SeatStorage | null) {
    this.key = `aos.identity.${serverOrigin(url)}`;
    this.storage = storage === undefined ? browserStorage() : storage;
  }

  /** @returns The kept token, or null. */
  load(): string | null {
    try {
      const token = this.storage?.getItem(this.key) ?? null;
      return token !== null && SHAPE.test(token) ? token : null;
    } catch {
      return null;
    }
  }

  /** @param token A token from the room server; anything not shaped like one is ignored. */
  save(token: string): void {
    if (!SHAPE.test(token)) return;
    try {
      this.storage?.setItem(this.key, token);
    } catch {
      // full or blocked: the next join gets a fresh device id
    }
  }
}
