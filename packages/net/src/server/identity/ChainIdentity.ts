/**
 * `ChainIdentity` — several providers, asked in order.
 */
import { IdentityProvider, type IdentityAuth, type PlayerIdentity } from './IdentityProvider.js';

/**
 * The first provider that knows the player wins. A provider that throws is
 * logged and skipped, as if it had said null.
 *
 * @example
 * ```ts
 * import { ChainIdentity, deviceIdentity, portalIdentity } from 'gameable/net/server';
 *
 * const who = new ChainIdentity([portalIdentity({ authUrl }), deviceIdentity(secret)]);
 * ```
 */
export class ChainIdentity extends IdentityProvider {
  /** @param providers Asked in this order. */
  constructor(private readonly providers: readonly IdentityProvider[]) {
    super();
  }

  async resolve(auth: IdentityAuth): Promise<PlayerIdentity | null> {
    for (const provider of this.providers) {
      try {
        const who = await provider.resolve(auth);
        if (who !== null) return who;
      } catch (error) {
        console.error('[identity] a provider threw; asking the next', error);
      }
    }
    return null;
  }
}

/**
 * @param providers Asked in order: put the portal before the device.
 * @returns One provider over them.
 *
 * @example
 * ```ts
 * import { chain, deviceIdentity, portalIdentity } from 'gameable/net/server';
 *
 * const who = await chain([portalIdentity({ authUrl }), deviceIdentity(secret)]).resolve({ token, headers });
 * ```
 */
export function chain(providers: readonly IdentityProvider[]): ChainIdentity {
  return new ChainIdentity(providers);
}
