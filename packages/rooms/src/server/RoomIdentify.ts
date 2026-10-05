/**
 * `RoomIdentify` — who a join is, for `GameableColyseusRoom.onAuth`: the room's
 * `Identities` asked with the join's device token and session, and the
 * seat's name that follows from the answer.
 */
import type { Identities, IdentityAuth, PlayerIdentity } from '@gameable/net/server';

import { type GameableJoinOptions, displayName } from './RoomAdmission.js';

/** A device token or session token longer than this is not one: nothing is asked. */
const MAX_TOKEN = 4096;

/**
 * What `onAuth` hands `onJoin` (Colyseus's `client.auth`): the seat's name,
 * the player's identity, and a device token to send the page.
 *
 * @example
 * ```ts
 * import type { SeatAuth } from 'gameable/rooms/server';
 *
 * const auth: SeatAuth = { name: 'ana', identity: { id: 'u1', name: 'ana', kind: 'portal' }, minted: null };
 * ```
 */
export interface SeatAuth {
  /** The seat's name: the portal's for a signed-in player, else the typed one. */
  readonly name: string;
  /** Who the player is, or null in a room without `Identities`. */
  readonly identity: PlayerIdentity | null;
  /** A fresh device token for the page (`IDENTITY_TYPE`), or null. */
  readonly minted: string | null;
}

/**
 * @param value A join option.
 * @returns It, when it is a string of a sane length; else undefined.
 */
function tokenText(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' && value.length <= MAX_TOKEN ? value : undefined;
}

/**
 * The join's credentials as the providers read them: the `device` option as
 * the token; the upgrade's `Cookie` header; and the `portal` option as a
 * bearer token (a browser cannot set `Authorization` on a WebSocket), else
 * the `Authorization` header a Node client sent.
 *
 * @param options The join options.
 * @param headers The upgrade request's headers.
 * @returns The providers' input.
 */
export function joinAuth(options: GameableJoinOptions, headers: Headers | undefined): IdentityAuth {
  const read: Record<string, string> = {};
  const cookie = headers?.get('cookie');
  if (typeof cookie === 'string') read.cookie = cookie;
  const portal = tokenText(options.portal);
  const authorization = portal === undefined ? headers?.get('authorization') : `Bearer ${portal}`;
  if (typeof authorization === 'string') read.authorization = authorization;
  return { token: tokenText(options.device), headers: read };
}

/**
 * Who joins. A room without `Identities` (a bare `Server` in a test) seats
 * everyone by their typed name and resolves no identity.
 *
 * The name rule: a signed-in (portal) player's seat carries the portal's
 * name, whatever the page typed; a guest keeps the typed name, capped to
 * 32 characters (`displayName`).
 *
 * @param identities The room's identities, or null.
 * @param options The join options.
 * @param headers The upgrade request's headers.
 * @returns The seat's name, identity and any minted device token.
 *
 * @example
 * ```ts
 * import { identifyJoin } from 'gameable/rooms/server';
 *
 * const auth = await identifyJoin(identities, { name: 'Mallory', device: token }, context.headers);
 * ```
 */
export async function identifyJoin(
  identities: Identities | null,
  options: GameableJoinOptions,
  headers: Headers | undefined,
): Promise<SeatAuth> {
  if (identities === null) return { name: displayName(options.name), identity: null, minted: null };
  const { identity, minted } = await identities.identify(joinAuth(options, headers));
  const name = identity.kind === 'portal' ? identity.name : displayName(options.name);
  return { name, identity, minted };
}
