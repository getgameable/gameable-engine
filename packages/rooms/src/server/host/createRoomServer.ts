/**
 * `createRoomServer` — the room server: Colyseus with our room for every
 * game in a catalog, four-letter codes, origin checks, per-address limits, a
 * room cap, one lobby and `/health`.
 */
import type { AddressInfo } from 'node:net';

import { type Identities, identitiesFromEnv } from '@gameable/net/server';
import { type Presence, Server } from '@colyseus/core';
import { WebSocketTransport } from '@colyseus/ws-transport';

import { GameableColyseusRoom } from '../GameableColyseusRoom.js';
import { createRoomCodes } from './codes.js';
import { readHealth, type RoomServerHealth } from './health.js';
import { createSingleLobby } from './lobby.js';
import { createOriginPolicy, type OriginPolicy } from './origins.js';
import { ProcessGuard } from './ProcessGuard.js';
import type { GateLimits } from './AddressLimits.js';
import { RequestGate } from './RequestGate.js';
import {
  type CatalogGame,
  createRoomCatalog,
  LOBBY_ROOM,
  type RoomCatalog,
} from './RoomCatalog.js';
import { createRoomRegistry, type RoomRegistry } from './RoomRegistry.js';

/**
 * What `createRoomServer` takes.
 *
 * @example
 * ```ts
 * import type { RoomServerOptions } from 'gameable/rooms/server';
 *
 * const options: RoomServerOptions = { port: 8790, origins: ['https://play.example'], games: { party } };
 * ```
 */
export interface RoomServerOptions {
  /** Port to bind; 0 for any free one (`listen()` resolves to it). */
  readonly port: number;
  /** Interface to bind. Default `127.0.0.1`; a container passes `0.0.0.0`. */
  readonly host?: string;
  /** Page origins allowed in (`https://play.example`, `http://localhost:*`); see `OriginPolicy`. */
  readonly origins: readonly string[];
  /** The games, by room name, or a catalog built beforehand. */
  readonly games: Readonly<Record<string, CatalogGame>> | RoomCatalog;
  /** Rooms this process may hold at once. Default 8 (the Jolt measurement). */
  readonly maxRooms?: number;
  /**
   * How long a dropped seat is held for its player, in ms. Default 30,000. It
   * applies to a prebuilt catalog too, except to a game that set its own
   * `reconnectSeconds`.
   */
  readonly leaveAfterMs?: number;
  /** Colyseus presence. Default its local presence; Redis is phase 6. */
  readonly presence?: Presence;
  /** Per-address and process-wide limits; see `GateLimits`. */
  readonly limits?: GateLimits;
  /**
   * Trusted proxies in front of the server (nginx alone: 1; Traefik then nginx: 2). The
   * client is the entry that many places from the right of `X-Forwarded-For`. Default 0:
   * the socket's peer (a warning is logged once if forwarding headers arrive anyway).
   */
  readonly trustProxy?: number;
  /**
   * Who joins (Task 5.3). Default `identitiesFromEnv(process.env)`:
   * `ROOMS_SECRET` signs device tokens (in production, under 32 bytes the
   * server refuses to start) and `GAMEABLE_AUTH_URL` adds Gameable sign-in. Null
   * resolves no identity.
   */
  readonly identities?: Identities | null;
}

/** The express response calls `/health` makes. */
interface HealthResponse {
  status(code: number): HealthResponse;
  json(body: unknown): void;
}

/** The express calls the server makes (express ships no types here). */
interface HealthApp {
  get(path: string, handler: (req: unknown, res: HealthResponse) => void): void;
}

/** `/health`'s status when not ok: orchestrators and the container's HEALTHCHECK read the status, not the body. */
const UNHEALTHY = 503;

/**
 * A room server. One per process: Colyseus's matchmaker is a process-wide singleton.
 *
 * Every HTTP matchmaking call passes a `RequestGate` first: a refused origin
 * gets the same 403 whatever room it names; failed lookups (10, then 1 per
 * 2 s) and creates (4 a minute) are limited per address, with 429 past them.
 * The WebSocket upgrade is refused 403 before the handshake.
 *
 * @example
 * ```ts
 * import { createRoomServer, engineGame } from 'gameable/rooms/server';
 *
 * const server = createRoomServer({
 *   port: 8790,
 *   origins: ['https://play.example'],
 *   games: { party: engineGame({ definition: game, guest, manifest: './assets.json', seed: 7 }) },
 * });
 * const port = await server.listen();
 * console.log(server.health()); // { ok: true, rooms: 0, players: 0, uptime: 0.01, games: [...] }
 * await server.close();
 * ```
 */
export class RoomServer {
  readonly catalog: RoomCatalog;
  readonly registry: RoomRegistry;
  private readonly policy: OriginPolicy;
  private readonly gate: RequestGate;
  private readonly guard: ProcessGuard;
  private readonly transport: WebSocketTransport;
  private readonly server: Server;
  private readonly startedAt = performance.now();
  private serving = false;
  private closed = false;

  /** @param options See `RoomServerOptions`. */
  constructor(private readonly options: RoomServerOptions) {
    const reconnectSeconds = (options.leaveAfterMs ?? 30_000) / 1000;
    const games = options.games;
    this.catalog = isCatalog(games) ? games : createRoomCatalog(games, { reconnectSeconds });
    // A prebuilt catalog still gets the server's hold, unless a game set its own.
    const holds = options.leaveAfterMs === undefined ? undefined : { reconnectSeconds };
    const maxRooms = options.maxRooms ?? 8;
    const direct = this.catalog.directNames();
    if (direct.length > 0 && maxRooms > 1)
      throw new Error(
        `createRoomServer: ${direct.join(', ')} run in direct mode, and two direct rooms in one ` +
          `process share the SDK's state; pass the wasm guest (engineGame({ definition, guest })) ` +
          `or maxRooms: 1 (the dev server), not maxRooms: ${String(maxRooms)}`,
      );
    this.policy = createOriginPolicy(options.origins);
    this.gate = new RequestGate(this.policy, options.limits ?? {}, options.trustProxy ?? 0);
    this.registry = createRoomRegistry(maxRooms, createRoomCodes(), this.gate);
    this.guard = new ProcessGuard((error) => {
      this.registry.noteFailure(error); // a Jolt abort marks the process not ok
    });
    const identities =
      options.identities === undefined ? identitiesFromEnv(process.env) : options.identities;
    const gate = this.gate;
    this.transport = new WebSocketTransport({
      // The upgrade: origin and failed-lookup budget, before the handshake.
      beforeUpgrade: (request) => gate.checkUpgrade(request),
    });
    this.server = new Server({
      transport: this.transport,
      presence: options.presence,
      greet: false,
      gracefullyShutdown: false, // its uncaughtException handler would end every room for one throw
      express: (app: HealthApp) => {
        app.get('/health', (_req, res) => {
          const health = this.health();
          res.status(health.ok ? 200 : UNHEALTHY).json(health);
        });
      },
    });
    for (const name of this.catalog.names()) {
      const entry = this.catalog.entry(name, holds);
      this.server
        .define(name, GameableColyseusRoom, {
          entry,
          registry: this.registry,
          limits: this.gate.limits,
          ...(identities === null ? {} : { identities }),
        })
        .filterBy(['code'])
        .enableRealtimeListing();
    }
    this.server.define(LOBBY_ROOM, createSingleLobby(this.gate.limits));
  }

  /** @returns The origin policy the server checks against. */
  get origins(): OriginPolicy {
    return this.policy;
  }

  /**
   * @returns The bound port. Installs the gate, and once bound, the process guard.
   * @throws {Error} The bind's error (`EADDRINUSE`...); the gate is removed again.
   */
  async listen(): Promise<number> {
    const http = this.transport.server;
    if (http === undefined) throw new Error('RoomServer: the transport has no HTTP server');
    this.gate.install();
    // The transport logs every HTTP server error with its stack. A failed bind is
    // this promise's to report (serve prints one clean line), so its logger is off
    // until the bind settles, and put back for errors after that.
    const loggers = http.listeners('error') as ((error: Error) => void)[];
    http.removeAllListeners('error');
    try {
      // Colyseus listens for the server's errors only once it is listening: a failed
      // bind would reach the process and leave this promise pending forever.
      await new Promise<void>((resolve, reject) => {
        http.once('error', reject);
        this.server.listen(this.options.port, this.options.host ?? '127.0.0.1').then(() => {
          http.off('error', reject);
          resolve();
        }, reject);
      });
    } catch (error) {
      this.gate.uninstall();
      throw error;
    } finally {
      for (const logger of loggers) http.on('error', logger);
    }
    this.guard.install();
    http.prependListener('request', this.gate.stampPeer); // first: before Colyseus reads the headers
    http.prependListener('upgrade', this.gate.stampPeer);
    this.serving = true;
    return (http.address() as AddressInfo).port;
  }

  /** Close every room and stop listening, without exiting the process. Twice is harmless. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.serving = false;
    try {
      await this.server.gracefullyShutdown(false);
    } finally {
      this.gate.uninstall();
      this.guard.uninstall();
    }
  }

  /**
   * @returns The live rooms and seats in this process, and the uptime. `ok` is false once
   *   closed, and once Jolt has aborted or a room's physics failed to start (`registry.broken`):
   *   the orchestrator should replace the process.
   */
  health(): RoomServerHealth {
    const ok = this.serving && this.registry.broken === null;
    return readHealth(ok, this.registry, this.startedAt, performance.now(), this.catalog.names());
  }
}

/**
 * @param games A record of games or a catalog.
 * @returns True for a catalog.
 */
function isCatalog(games: RoomServerOptions['games']): games is RoomCatalog {
  return (
    typeof (games as Partial<RoomCatalog>).entry === 'function' && typeof games.names === 'function'
  );
}

/**
 * Make a room server: every game in `games` defined once on Colyseus as
 * `GameableColyseusRoom`, filtered by `code`, plus one `lobby` (Colyseus's `LobbyRoom`).
 *
 * @param options Port, host, origins, games, `maxRooms`, `leaveAfterMs`, presence, limits, `trustProxy`, `identities`.
 * @returns The server, not yet listening.
 * @throws {TypeError} When an origin is not one.
 * @throws {Error} In production, when `ROOMS_SECRET` is under 32 bytes (`identitiesFromEnv`).
 * @throws {Error} When a game name or `maxPlayers` is bad, or a direct-mode
 *   game (no wasm guest) is registered with `maxRooms` above 1.
 *
 * @example
 * ```ts
 * import { createRoomServer, engineGame } from 'gameable/rooms/server';
 * import game from './game.js';
 *
 * const server = createRoomServer({
 *   port: 8790,
 *   origins: ['https://play.example', 'http://localhost:*'],
 *   games: { party: engineGame({ definition: game, guest, manifest: './assets.json', seed: 7 }) },
 * });
 * await server.listen();
 * ```
 */
export function createRoomServer(options: RoomServerOptions): RoomServer {
  return new RoomServer(options);
}
