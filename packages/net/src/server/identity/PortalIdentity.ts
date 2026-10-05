/**
 * `PortalIdentity` — a player signed in to Gameable, asked of the Gameable
 * auth service.
 *
 * `GET {authUrl}/auth/me`:
 * - authenticates by the `avataros_session` cookie ONLY (an access token, a
 *   JWT, HttpOnly, 1 h). It reads no `Authorization` header. The cookie is
 *   scoped to the auth service's parent domain, `SameSite=Lax` in production
 *   and `None` on staging.
 * - 200: `{ id: string (the user's uuid, the JWT sub), email: string,
 *   org_id: string | null, org_slug: string | null, org_name: string | null,
 *   org_created_at: string | null, roles: string[] }`. There is no name
 *   field: the name is the email's local part.
 * - 401 `{ error: 'Unauthorized' }`: no cookie, or a bad or expired token.
 * - 500 when the organisation lookup fails.
 *
 * So the session reaches this provider two ways, and both go to `/auth/me`
 * as that one cookie (the rest of the page's cookie jar is never forwarded):
 * the browser's own `Cookie` header, on a page under that cookie domain; or a
 * bearer token the page passes, for a page on any other domain, where the
 * browser never sends the cookie to the room server.
 */
import { IdentityProvider, type IdentityAuth, type PlayerIdentity } from './IdentityProvider.js';

/** The auth service's session cookie. */
export const SESSION_COOKIE = 'avataros_session';
const SESSION = new RegExp(`(?:^|;\\s*)${SESSION_COOKIE}=([^;]+)`);
const BEARER = /^Bearer\s+(\S+)$/i;
const NAME_LIMIT = 32;

/**
 * Options for {@link portalIdentity}.
 *
 * @example
 * ```ts
 * import type { PortalIdentityOptions } from 'gameable/net/server';
 *
 * const options: PortalIdentityOptions = { authUrl: 'https://auth.example.com', fetch };
 * ```
 */
export interface PortalIdentityOptions {
  /** The auth service's origin (`GAMEABLE_AUTH_URL`). */
  readonly authUrl: string;
  /** The `fetch` to call it with. Default the global one. */
  readonly fetch?: (url: string, init?: RequestInit) => Promise<Response>;
  /** How long a join waits for the auth service before it plays as a guest. Default 3000 ms. */
  readonly timeoutMs?: number;
}

/**
 * The portal user behind a join's session, or null (none, refused, the
 * service down or slow: the chain falls through to the device).
 *
 * @example
 * ```ts
 * import { PortalIdentity } from 'gameable/net/server';
 *
 * const portal = new PortalIdentity({ authUrl: 'https://auth.example.com' });
 * const who = await portal.resolve({ headers: { cookie: request.headers.cookie ?? '' } });
 * ```
 */
export class PortalIdentity extends IdentityProvider {
  private readonly me: string;
  private readonly fetch: (url: string, init?: RequestInit) => Promise<Response>;
  private readonly timeoutMs: number;

  /** @param options The auth service and how to reach it. */
  constructor(options: PortalIdentityOptions) {
    super();
    if (!/^https?:\/\/[^/]/.test(options.authUrl))
      throw new Error(`portalIdentity: authUrl must be an http(s) URL, not "${options.authUrl}"`);
    this.me = `${options.authUrl.replace(/\/+$/, '')}/auth/me`;
    this.fetch = options.fetch ?? ((url, init) => globalThis.fetch(url, init));
    this.timeoutMs = options.timeoutMs ?? 3000;
  }

  async resolve(auth: IdentityAuth): Promise<PlayerIdentity | null> {
    const session = sessionOf(auth.headers);
    if (session === null) return null;
    let body: unknown;
    try {
      const response = await this.fetch(this.me, {
        headers: { cookie: `${SESSION_COOKIE}=${session}`, authorization: `Bearer ${session}` },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (response.status === 401) return null;
      if (!response.ok) throw new Error(`answered ${String(response.status)}`);
      body = await response.json();
    } catch (error) {
      console.warn(`[identity] ${this.me}: ${String(error)}; the player joins as a guest`);
      return null;
    }
    return identityOf(body);
  }
}

/**
 * @param headers The join's headers.
 * @returns The session token: the cookie, else a bearer token; or null.
 */
function sessionOf(headers: IdentityAuth['headers']): string | null {
  const cookie = SESSION.exec(headers.cookie ?? '')?.[1];
  if (cookie !== undefined && cookie !== '') return cookie;
  return BEARER.exec(headers.authorization ?? '')?.[1] ?? null;
}

/**
 * @param body `/auth/me`'s JSON.
 * @returns The identity, or null when it names no user.
 */
function identityOf(body: unknown): PlayerIdentity | null {
  if (typeof body !== 'object' || body === null) return null;
  const { id, name, email } = body as { id?: unknown; name?: unknown; email?: unknown };
  if (typeof id !== 'string' || id === '') return null;
  const local = typeof email === 'string' ? email.split('@')[0] : '';
  const chosen = (typeof name === 'string' ? name.trim() : '') || local.trim() || 'player';
  return { id, name: chosen.slice(0, NAME_LIMIT), kind: 'portal' };
}

/**
 * Gameable sign-in: `GET {authUrl}/auth/me` with the join's session.
 *
 * @param options The auth service, a `fetch`, a timeout.
 * @returns The provider.
 *
 * @example
 * ```ts
 * import { chain, deviceIdentity, portalIdentity } from 'gameable/net/server';
 *
 * const who = chain([portalIdentity({ authUrl: 'https://auth.example.com', fetch }), deviceIdentity(secret)]);
 * ```
 */
export function portalIdentity(options: PortalIdentityOptions): PortalIdentity {
  return new PortalIdentity(options);
}
