/**
 * `identitiesFromEnv` — the room server's identities from its environment.
 */
import { deviceIdentity } from './DeviceIdentity.js';
import { base64url, randomBytes } from './hmac.js';
import { createIdentities, type Identities } from './Identities.js';
import { portalIdentity, type PortalIdentityOptions } from './PortalIdentity.js';

/** The shortest `ROOMS_SECRET` production starts with: 32 bytes, HMAC-SHA256's own size. */
export const MIN_SECRET_BYTES = 32;

/**
 * The variables read: `ROOMS_SECRET` signs device tokens; `GAMEABLE_AUTH_URL`
 * (optional) turns on Gameable sign-in; `NODE_ENV=production` makes a
 * missing or short secret fatal.
 *
 * @example
 * ```ts
 * import type { IdentityEnv } from 'gameable/net/server';
 *
 * const env: IdentityEnv = { ROOMS_SECRET: 'at-least-thirty-two-bytes-of-secret', NODE_ENV: 'production' };
 * ```
 */
export type IdentityEnv = Readonly<Record<string, string | undefined>>;

let warnedEphemeral = false;

/**
 * Build the room server's identities, or refuse to start.
 *
 * - Production (`NODE_ENV=production`): `ROOMS_SECRET` must be at least 32
 *   bytes (UTF-8), else this throws and the server does not start.
 * - Anywhere else, a missing secret is a random one for this process, with
 *   a warning: device ids then last only until the server restarts.
 * - `GAMEABLE_AUTH_URL`, when set, must be an http(s) URL; it adds the portal.
 *
 * @param env The environment (`process.env`).
 * @param fetch The portal's `fetch`. Default the global one.
 * @returns The identities.
 * @throws {Error} On a production secret under 32 bytes, or a malformed `GAMEABLE_AUTH_URL`.
 *
 * @example
 * ```ts
 * import { identitiesFromEnv } from 'gameable/net/server';
 *
 * const identities = identitiesFromEnv(process.env);
 * ```
 */
export function identitiesFromEnv(
  env: IdentityEnv,
  fetch?: PortalIdentityOptions['fetch'],
): Identities {
  const secret = roomsSecret(env);
  const authUrl = env.GAMEABLE_AUTH_URL?.trim() ?? '';
  if (authUrl !== '' && !/^https?:\/\/[^/]/.test(authUrl))
    throw new Error(
      `GAMEABLE_AUTH_URL must be an http(s) URL (https://auth.example.com), not "${authUrl}"`,
    );
  return createIdentities({
    device: deviceIdentity(secret),
    portal: authUrl === '' ? null : portalIdentity({ authUrl, fetch }),
  });
}

/**
 * @param env The environment.
 * @returns The signing secret.
 */
function roomsSecret(env: IdentityEnv): string {
  const secret = env.ROOMS_SECRET ?? '';
  const bytes = new TextEncoder().encode(secret).length;
  if (env.NODE_ENV === 'production') {
    if (bytes < MIN_SECRET_BYTES)
      throw new Error(
        `ROOMS_SECRET must be at least ${String(MIN_SECRET_BYTES)} bytes in production ` +
          `(it is ${String(bytes)}); it signs every player's device token`,
      );
    return secret;
  }
  if (secret !== '') return secret;
  if (!warnedEphemeral)
    console.warn('[identity] ROOMS_SECRET is not set: device ids last until this server restarts');
  warnedEphemeral = true;
  return base64url(randomBytes(MIN_SECRET_BYTES));
}
