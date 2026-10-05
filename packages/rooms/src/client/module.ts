/**
 * `multiplayer()` for a page whose rooms run on the Colyseus room server:
 * `gameable/net/client`'s loader with a `ColyseusConnection` as its default.
 */
import { FeatureError, type LoadedFeature } from '@gameable/core/headless';
import { multiplayer as netMultiplayer, type MultiplayerClientOptions } from '@gameable/net/client';
import { roomMode } from '@gameable/net/page';

import { createColyseusConnection } from './ColyseusConnection.js';
import { roomsEndpoint } from './endpoint.js';
import type { SeatLocks } from './SeatLocks.js';
import type { SeatStorage } from './SeatTokens.js';

/** A page address: `location`, or a stand-in for one. */
export interface PageLocation {
  readonly href: string;
}

/**
 * Options for {@link multiplayer}: net's, plus where the room server is and
 * how to join it. Without a `connection`, one is made from these.
 *
 * @example
 * ```ts
 * import type { RoomsMultiplayerOptions } from 'gameable/rooms/client';
 * const options: RoomsMultiplayerOptions = { game: 'party', name: 'Ana', newRoom: true };
 * ```
 */
export interface RoomsMultiplayerOptions extends MultiplayerClientOptions {
  /** The room server. Default `roomsEndpoint(location.href)`: `<page origin>/services/rooms/`, or a local page's `?rooms=`. */
  url?: string;
  /** The game's name in the server's catalog. Default `'game'`. */
  game?: string;
  /** Make a fresh room ("new room"). Default true when the page's `?room=` is `new`. */
  newRoom?: boolean;
  /** With `newRoom`: a room joined by its code only, left out of public listings. */
  private?: boolean;
  /** Where reconnection tokens live. Default this tab's `sessionStorage`. */
  storage?: SeatStorage | null;
  /** Seat locks shared by the browser's tabs. Default `navigator.locks`. */
  locks?: SeatLocks | null;
  /** Where the device token lives. Default `localStorage`. */
  deviceStorage?: SeatStorage | null;
  /** A Gameable session token for a page off the auth service's cookie domain; see `ColyseusConnectionOptions.portalToken`. */
  portalToken?: () => string | null;
  /** A drop sooner than this after joining closes instead of resuming (the SDK's `minUptime`). Default 0. */
  minUptimeMs?: number;
  /** Headers for Node (a test's `origin`); a browser sends its own. */
  headers?: Readonly<Record<string, string>>;
  /** The page's address, for its `?room=` and `?rooms=`. Default `globalThis.location`. */
  location?: PageLocation;
}

/**
 * The page's `multiplayer` feature loader: the `net` module and service of
 * `gameable/net/client`, joined to a room on the Colyseus room server.
 *
 * - `?room=CODE` (or `room`) joins that room; `?room=new` (or `newRoom`)
 *   makes a fresh one; `?room=quick`, or neither, is a quick match
 *   (`joinOrCreate`).
 * - The server is `<page origin>/services/rooms/` (https to wss), `url`, or
 *   on a local page `?rooms=<url>`.
 * - Given a `connection` (Play Solo's loopback one), that is used instead,
 *   and nothing here touches Colyseus.
 *
 * @param options The game's `features.multiplayer` options and the page's own.
 * @returns The feature, or a `FeatureError` rejection when there is no page address and no `url`.
 *
 * @example
 * ```ts
 * import { resolveFeatures } from 'gameable/core';
 * import { multiplayer } from 'gameable/rooms/client';
 *
 * const loaded = await resolveFeatures(
 *   { multiplayer: { maxPlayers: 6 } },
 *   { multiplayer: (o) => multiplayer({ ...o, game: 'party', name: 'Ana' }) },
 * );
 * ```
 */
export function multiplayer(options: RoomsMultiplayerOptions = {}): Promise<LoadedFeature> {
  if (options.connection !== undefined) return netMultiplayer(options);
  const page = options.location ?? (globalThis as { location?: PageLocation }).location;
  let url = options.url;
  try {
    url ??= page === undefined ? undefined : roomsEndpoint(page.href);
  } catch (error) {
    return Promise.reject(
      new FeatureError('multiplayer: the page address or its ?rooms= is not a URL', {
        cause: error,
      }),
    );
  }
  if (url === undefined) {
    return Promise.reject(
      new FeatureError('multiplayer: no room server. Pass { url } when there is no page location.'),
    );
  }
  // One parser for `?room=`, the page's own (`gameable/net/page`).
  const mode = page === undefined ? null : roomMode(new URL(page.href).searchParams);
  const newRoom = options.newRoom ?? mode?.kind === 'new';
  const room = options.room ?? (mode?.kind === 'join' ? mode.code : undefined);
  const connection = createColyseusConnection({
    url,
    game: options.game ?? 'game',
    create: newRoom,
    private: options.private === true,
    ...(options.storage === undefined ? {} : { storage: options.storage }),
    ...(options.locks === undefined ? {} : { locks: options.locks }),
    ...(options.deviceStorage === undefined ? {} : { deviceStorage: options.deviceStorage }),
    ...(options.portalToken === undefined ? {} : { portalToken: options.portalToken }),
    ...(options.minUptimeMs === undefined ? {} : { minUptimeMs: options.minUptimeMs }),
    ...(options.headers === undefined ? {} : { headers: options.headers }),
  });
  return netMultiplayer({ ...options, ...(room === undefined ? {} : { room }), connection });
}
