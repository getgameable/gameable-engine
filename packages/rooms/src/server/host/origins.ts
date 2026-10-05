/**
 * The page origins allowed to open rooms.
 */

/** `scheme://host:*`: any port on that scheme and host. */
const ANY_PORT = /^([a-z][a-z0-9+.-]*):\/\/([^/:]+):\*$/;

/**
 * @param origin A list entry.
 * @returns Its normalized origin, or null when it is not one.
 */
function originOf(origin: string): string | null {
  try {
    const url = new URL(origin);
    const bare = origin.replace(/\/$/, '');
    if (url.origin === 'null' || url.origin.toLowerCase() !== bare.toLowerCase()) return null;
    return url.origin;
  } catch {
    return null;
  }
}

/**
 * Which browser pages may use the room server, by their `Origin` header.
 * An entry is an origin (`https://play.example`) or an origin with any port
 * (`http://localhost:*`). Case and a trailing slash do not count.
 *
 * A request with no `Origin`, or the opaque `null`, is refused: a browser
 * always sends one on a WebSocket upgrade and on a cross-origin POST, so a
 * missing one is a script, and a script can claim any origin anyway. What
 * this stops is a page on another site opening rooms with a visitor's
 * browser.
 *
 * @example
 * ```ts
 * import { createOriginPolicy } from 'gameable/rooms/server';
 *
 * const policy = createOriginPolicy(['https://play.example', 'http://localhost:*']);
 * policy.allows('http://localhost:5173'); // true
 * policy.allows('https://evil.example'); // false
 * ```
 */
export class OriginPolicy {
  private readonly exact = new Set<string>();
  private readonly anyPort: { scheme: string; host: string }[] = [];

  /**
   * @param origins The allowed origins.
   * @throws {TypeError} When an entry is not an origin.
   */
  constructor(origins: readonly string[]) {
    for (const entry of origins) {
      const port = ANY_PORT.exec(entry.toLowerCase());
      if (port !== null) {
        this.anyPort.push({ scheme: `${port[1]}:`, host: port[2] });
        continue;
      }
      const origin = originOf(entry);
      if (origin === null) throw new TypeError(`OriginPolicy: "${entry}" is not an origin`);
      this.exact.add(origin);
    }
  }

  /**
   * @param origin The request's `Origin` header.
   * @returns True when that page may use the server.
   */
  allows(origin: string | null | undefined): boolean {
    if (origin === undefined || origin === null || origin === '') return false;
    const normalized = originOf(origin);
    if (normalized === null) return false;
    if (this.exact.has(normalized)) return true;
    const url = new URL(normalized);
    return this.anyPort.some((rule) => rule.scheme === url.protocol && rule.host === url.hostname);
  }
}

/**
 * @param origins The allowed origins (`https://play.example`, `http://localhost:*`).
 * @returns The policy.
 *
 * @example
 * ```ts
 * import { createOriginPolicy } from 'gameable/rooms/server';
 *
 * const policy = createOriginPolicy(['https://play.example']);
 * ```
 */
export function createOriginPolicy(origins: readonly string[]): OriginPolicy {
  return new OriginPolicy(origins);
}
