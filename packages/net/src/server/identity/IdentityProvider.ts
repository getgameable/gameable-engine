/**
 * `IdentityProvider` — who a joining player is, beyond the seat they take:
 * the key their saved data lives under (Task 5.2) and, for a signed-in
 * player, the name the portal knows them by.
 */

/**
 * Who a player is. `id` is stable: the same device token, or the same
 * portal account, gives the same id on every join, in every room.
 *
 * - `portal`: a Gameable account; `id` is the auth service's user id, `name`
 *   the account's name. The room uses this name over any the page sent.
 * - `device`: a browser, by its device token; `id` is `device:<random>`,
 *   `name` is empty: the player's typed name is used.
 *
 * @example
 * ```ts
 * import type { PlayerIdentity } from 'gameable/net/server';
 *
 * const guest: PlayerIdentity = { id: 'device:q1x0kZ', name: '', kind: 'device' };
 * ```
 */
export interface PlayerIdentity {
  /** The stable key: a user id, or `device:<random>`. */
  readonly id: string;
  /** The account's display name; empty for a device. */
  readonly name: string;
  /** Where the id came from. */
  readonly kind: 'portal' | 'device';
}

/**
 * What a join carries for identifying its player.
 *
 * @example
 * ```ts
 * import type { IdentityAuth } from 'gameable/net/server';
 *
 * const auth: IdentityAuth = { token: 'device.abc.def', headers: { cookie: 'avataros_session=...' } };
 * ```
 */
export interface IdentityAuth {
  /** The device token the page kept from an earlier join, if any. */
  readonly token?: string;
  /** Request headers, lower-case names: `cookie` and `authorization` are read. */
  readonly headers: Readonly<Record<string, string | undefined>>;
}

/**
 * One way of knowing who a player is. `resolve` never throws for a bad
 * credential: it answers null, and `chain` moves on to the next provider.
 *
 * @example
 * ```ts
 * import { IdentityProvider, type IdentityAuth, type PlayerIdentity } from 'gameable/net/server';
 *
 * class Everyone extends IdentityProvider {
 *   resolve(_auth: IdentityAuth): Promise<PlayerIdentity | null> {
 *     return Promise.resolve({ id: 'device:same', name: '', kind: 'device' });
 *   }
 * }
 * ```
 */
export abstract class IdentityProvider {
  /**
   * @param auth The join's token and headers.
   * @returns Who the player is, or null when this provider cannot say.
   */
  abstract resolve(auth: IdentityAuth): Promise<PlayerIdentity | null>;
}
