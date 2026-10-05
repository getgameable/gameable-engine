/**
 * `RoomAdmission` — what a join must pass before it takes a seat in an
 * `GameableColyseusRoom`: our protocol version, this room's game, and the game's
 * own `admit` hook. `GameableColyseusRoom.onAuth` runs it.
 */
import { PROTOCOL_VERSION } from '@gameable/net';
import type { RoomGame } from '@gameable/net/server';
import { ServerError } from '@colyseus/core';

/** The `ServerError.code` of a join that speaks another protocol version (HTTP 426, Upgrade Required). */
export const VERSION_REFUSED_CODE = 426;
/** Colyseus's `MATCHMAKE_INVALID_ROOM_ID`: what a wrong code gets, so another game's code looks the same. */
const NO_SUCH_ROOM = 522;
/** Colyseus's `AUTH_FAILED`: the game's `admit` said no. */
export const ADMIT_REFUSED_CODE = 525;

/**
 * The join options a page sends (`ColyseusConnection`): its display name, its
 * game, our protocol version, the token the game's `admit` may check, and
 * who the player is (`device`, `portal`; `identifyJoin`). They travel in the
 * matchmaking request's body, never in a URL.
 *
 * @example
 * ```ts
 * import type { GameableJoinOptions } from 'gameable/rooms/server';
 *
 * const options: GameableJoinOptions = { name: 'Ana', game: 'party', v: 1 };
 * ```
 */
export interface GameableJoinOptions {
  /** The display name. */
  name?: unknown;
  /** The game the page runs: the room's name in the catalog. */
  game?: unknown;
  /** `PROTOCOL_VERSION` of the page. */
  v?: unknown;
  /** Handed to the game's `admit` hook. */
  token?: unknown;
  /** The device token this page kept from an earlier join (`IDENTITY_TYPE`). */
  device?: unknown;
  /** A Gameable session token, for a page whose domain the session cookie does not reach. */
  portal?: unknown;
}

/** What admission reads from its room. */
export interface AdmittingRoom {
  readonly roomId: string;
  readonly roomName: string;
}

/**
 * @param name The join option `name`.
 * @returns The display name both admission and the seat use: the first 32 characters, or `player`.
 *
 * @example
 * ```ts
 * import { displayName } from 'gameable/rooms/server';
 *
 * displayName('Ana'); // 'Ana'
 * displayName(7); // 'player'
 * ```
 */
export function displayName(name: unknown): string {
  return typeof name === 'string' ? name.slice(0, 32) : 'player';
}

/**
 * The cheap checks, before anything is asked of the auth service:
 *
 * 1. `v` is our `PROTOCOL_VERSION`, else `VERSION_REFUSED_CODE`: a tab still
 *    holding an older page would decode rows it cannot read;
 * 2. `game` is this room's name, else Colyseus's own "not found" (522): a
 *    code from another game in the same process joins nothing, and looks
 *    like a wrong code.
 *
 * @param room The room.
 * @param game Its game, or null while it is being built.
 * @param options The client's join options.
 * @returns The game, once the join speaks our version and names it.
 * @throws {ServerError} When refused.
 *
 * @example
 * ```ts
 * import { checkJoin } from 'gameable/rooms/server';
 *
 * const game = checkJoin(room, room.game, { name: 'Ana', game: 'party', v: 1 });
 * ```
 */
export function checkJoin(
  room: AdmittingRoom,
  game: RoomGame | null,
  options: GameableJoinOptions = {},
): RoomGame {
  if (options.v !== PROTOCOL_VERSION)
    throw new ServerError(
      VERSION_REFUSED_CODE,
      `the room server speaks protocol ${String(PROTOCOL_VERSION)}; reload the page`,
    );
  if (options.game !== room.roomName || game === null)
    throw new ServerError(NO_SUCH_ROOM, `room "${room.roomId}" not found`);
  return game;
}

/**
 * Check a join before its seat is taken: `checkJoin`, then the game's
 * `admit` hook, if it has one, on the seat's name and the token, else
 * `ADMIT_REFUSED_CODE` with the game's words (a hook that throws is logged
 * and refused `admission failed`).
 *
 * @param room The room.
 * @param roomGame Its game, or null while it is being built.
 * @param options The client's join options.
 * @param name The seat's name (`seatName`). Default `displayName(options.name)`.
 * @returns True once admitted.
 * @throws {ServerError} When refused.
 *
 * @example
 * ```ts
 * import { admitJoin } from 'gameable/rooms/server';
 *
 * await admitJoin(room, room.game, { name: 'Ana', game: 'party', v: 1 });
 * ```
 */
export async function admitJoin(
  room: AdmittingRoom,
  roomGame: RoomGame | null,
  options: GameableJoinOptions = {},
  name: string = displayName(options.name),
): Promise<true> {
  const game = checkJoin(room, roomGame, options);
  const token = typeof options.token === 'string' ? options.token : undefined;
  let refusal: string | null | undefined;
  try {
    refusal = await game.admit?.(name, token);
  } catch (error) {
    console.error(`[rooms] room ${room.roomId} (${room.roomName}): admit threw`, error);
    refusal = 'admission failed';
  }
  if (typeof refusal === 'string') throw new ServerError(ADMIT_REFUSED_CODE, refusal);
  return true;
}
