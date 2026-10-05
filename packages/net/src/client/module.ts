/**
 * `multiplayer()` — the page's `multiplayer` feature: the `net` module, which
 * is the `net` service the client loop drains (the loop starts the join once
 * it is attached), pings the room and watches the link each fixed step, lets
 * go of the page's keys the moment the page goes away, and leaves on dispose.
 */
import { FeatureError, type EngineModule, type LoadedFeature } from '@gameable/core';

import type { NetService } from './NetService.js';
import { createNetClient, type NetClient } from './NetClient.js';
import { showNetOnOverlay } from './NetOverlayLine.js';
import { PageAway, type AwaySources } from './PageAway.js';
import type { RoomConnection } from './RoomConnection.js';

declare module '@gameable/core' {
  interface EngineServices {
    /** The room this page is in: its seat, its players, and the authority's queued frames. */
    net: NetService;
  }
}

/**
 * Options for {@link multiplayer}: the game's `features.multiplayer` block,
 * plus what the page decides.
 *
 * @example
 * ```ts
 * import { createLoopbackConnection, type MultiplayerClientOptions } from 'gameable/net/client';
 * import { loopbackPair } from 'gameable/net/testing';
 * const options: MultiplayerClientOptions = {
 *   maxPlayers: 6,
 *   name: 'Ana',
 *   connection: createLoopbackConnection({ connect: () => loopbackPair()[0] }),
 * };
 * ```
 */
export interface MultiplayerClientOptions {
  /** The room's seats (`features.multiplayer.maxPlayers`). Defaults to 8. */
  maxPlayers?: number;
  /** Rows per second the room sends (`features.multiplayer.sendHz`); the client blends across one interval. Defaults to 20. */
  sendHz?: number;
  /** The link to the room. Required here; `@gameable/rooms/client`'s `multiplayer()` defaults it to the room server. */
  connection?: RoomConnection;
  /** The display name to join with. */
  name?: string;
  /** The room code to join. */
  room?: string;
  /** Milliseconds between pings. Defaults to 2,000. */
  pingEveryMs?: number;
  /** The clock for pings, in ms. Defaults to `performance.now`. */
  now?: () => number;
  /** Milliseconds of fixed steps with no server frame before the link is dropped and resumed. Defaults to 2,000. */
  silenceMs?: number;
  /** Where the page's hide, blur and unload events come from. Defaults to the browser's `window` and `document`. */
  away?: AwaySources;
}

/** The `net` engine module: one `NetClient` for the engine's life. */
export class NetModule implements EngineModule {
  readonly id = 'net';
  /** After input (-100), before the game module (-50). */
  readonly order = -90;
  private sinceMs = 0;
  private away: PageAway | null = null;

  /**
   * @param client The service this module owns.
   * @param pingEveryMs Milliseconds between pings.
   * @param awaySources Where the page's hide, blur and unload events come from.
   */
  constructor(
    readonly client: NetClient,
    private readonly pingEveryMs: number,
    private readonly awaySources: AwaySources = {},
  ) {}

  /**
   * @returns The service, registered as `net`. The join does not start here:
   *   the client loop starts it once it is attached, after the page has loaded.
   */
  init(): NetClient {
    this.away ??= new PageAway(this.release, this.awaySources);
    return this.client;
  }

  /** @param dt The fixed step, in seconds: pings and the silence watch go on simulated time, so a hidden tab sends none. */
  fixedUpdate(dt: number): void {
    const ms = dt * 1000;
    this.client.watch(ms);
    this.sinceMs += ms;
    if (this.sinceMs < this.pingEveryMs) return;
    this.sinceMs = 0;
    this.client.ping();
  }

  dispose(): void {
    this.away?.dispose();
    this.away = null;
    this.client.leave('disposed');
  }

  /** The page went away: the room must not keep applying the keys it last heard. */
  private readonly release = (): void => {
    this.client.releaseInput();
  };
}

/**
 * The page's `multiplayer` feature loader: the `net` module, and a `bind`
 * that resolves to the `NetService` and, when the engine has a debug overlay
 * (`createEngine({ debug: true })`), adds the `net` lines to it.
 *
 * @param options The game's `features.multiplayer` options and the page's own.
 * @returns The feature, or a rejection (a `FeatureError`) when no connection is given.
 *
 * @example
 * ```ts
 * import { resolveFeatures } from 'gameable/core';
 * import { createLoopbackConnection, multiplayer } from 'gameable/net/client';
 * import { loopbackPair } from 'gameable/net/testing';
 *
 * const connection = createLoopbackConnection({ connect: () => loopbackPair()[0] });
 * const loaded = await resolveFeatures(
 *   { multiplayer: { maxPlayers: 6 } },
 *   { multiplayer: (o) => multiplayer({ ...o, connection, name: 'Ana' }) },
 * );
 * ```
 */
export function multiplayer(options: MultiplayerClientOptions = {}): Promise<LoadedFeature> {
  const connection = options.connection;
  if (connection === undefined) {
    return Promise.reject(
      new FeatureError(
        'multiplayer: no room server connection. Pass { connection } (createLoopbackConnection for a ' +
          "room in the page), or load @gameable/rooms/client's multiplayer(), which connects to the room server.",
      ),
    );
  }
  const client = createNetClient(connection, {
    ...(options.name === undefined ? {} : { name: options.name }),
    ...(options.room === undefined ? {} : { room: options.room }),
    ...(options.maxPlayers === undefined ? {} : { maxPlayers: options.maxPlayers }),
    ...(options.sendHz === undefined ? {} : { sendHz: options.sendHz }),
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.silenceMs === undefined ? {} : { silenceMs: options.silenceMs }),
  });
  const module = new NetModule(client, options.pingEveryMs ?? 2_000, options.away);
  return Promise.resolve({
    name: 'multiplayer',
    modules: [module],
    bind: (engine) => {
      showNetOnOverlay(engine, client);
      return Promise.resolve(client);
    },
  });
}
