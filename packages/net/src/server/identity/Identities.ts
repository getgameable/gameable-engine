/**
 * `Identities` — what a room asks at each join: who is this, and does the
 * page need a new device token.
 */
import type { DeviceIdentity } from './DeviceIdentity.js';
import type { IdentityAuth, PlayerIdentity } from './IdentityProvider.js';
import type { PortalIdentity } from './PortalIdentity.js';

/**
 * A join's answer: the player, and the device token minted for the page to
 * keep (null when the page already sent a valid one).
 *
 * @example
 * ```ts
 * import type { JoinIdentity } from 'gameable/net/server';
 *
 * const answer: JoinIdentity = { identity: { id: 'u1', name: 'ana', kind: 'portal' }, minted: null };
 * ```
 */
export interface JoinIdentity {
  readonly identity: PlayerIdentity;
  readonly minted: string | null;
}

/**
 * Options for {@link createIdentities}.
 *
 * @example
 * ```ts
 * import { deviceIdentity, type IdentitiesOptions } from 'gameable/net/server';
 *
 * const options: IdentitiesOptions = { device: deviceIdentity(secret) };
 * ```
 */
export interface IdentitiesOptions {
  /** Device tokens: always there, so every player has an id. */
  readonly device: DeviceIdentity;
  /** Gameable sign-in, asked first. Default none. */
  readonly portal?: PortalIdentity | null;
}

/**
 * The portal first, then the device token. A join whose device token is
 * missing or does not verify gets a fresh one, minted here, whether or not
 * the player is signed in: a player who signs out later is still the same
 * device. A forged token never yields the id it names.
 *
 * @example
 * ```ts
 * import { createIdentities, deviceIdentity } from 'gameable/net/server';
 *
 * const identities = createIdentities({ device: deviceIdentity(secret) });
 * const { identity, minted } = await identities.identify({ token, headers });
 * ```
 */
export class Identities {
  readonly device: DeviceIdentity;
  readonly portal: PortalIdentity | null;

  /** @param options The providers. */
  constructor(options: IdentitiesOptions) {
    this.device = options.device;
    this.portal = options.portal ?? null;
  }

  /**
   * @param auth The join's device token and headers.
   * @returns Who joins, and a token to hand back when one was minted.
   */
  async identify(auth: IdentityAuth): Promise<JoinIdentity> {
    const [portal, device] = await Promise.all([
      this.portal?.resolve(auth) ?? Promise.resolve(null),
      this.device.resolve(auth),
    ]);
    if (device !== null) return { identity: portal ?? device, minted: null };
    const fresh = await this.device.mint();
    return { identity: portal ?? fresh.identity, minted: fresh.token };
  }
}

/**
 * @param options The device provider, and the portal if any.
 * @returns The room's identities.
 *
 * @example
 * ```ts
 * import { createIdentities, deviceIdentity, portalIdentity } from 'gameable/net/server';
 *
 * const identities = createIdentities({
 *   device: deviceIdentity(secret),
 *   portal: portalIdentity({ authUrl: 'https://auth.example.com' }),
 * });
 * ```
 */
export function createIdentities(options: IdentitiesOptions): Identities {
  return new Identities(options);
}
