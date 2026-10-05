/**
 * `RequestGate` — every HTTP matchmaking request and every WebSocket upgrade
 * passes it before Colyseus looks at a room: the origin, then the limits.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import type { IncomingMessage } from 'node:http';

import { type AuthContext, matchMaker, ServerError } from '@colyseus/core';

import { AddressLimits, type GateLimits } from './AddressLimits.js';
import { clientIpOf, PEER_HEADER } from './clientIp.js';
import type { OriginPolicy } from './origins.js';
import { LOBBY_ROOM } from './RoomCatalog.js';

/** The header the server writes with the raw request path (`req.url`), over anything sent. */
export const PATH_HEADER = 'x-aos-path';
/** The join option the gate writes with the client's limit key, over anything sent (the lobby reads it). */
export const PEER_OPTION = 'aosPeer';

const FORBIDDEN = 403;
const TOO_MANY = 429;
/** Colyseus's `MATCHMAKE_INVALID_ROOM_ID`: its own answer to a code no room has. */
const NO_SUCH_ROOM = 522;
/** Colyseus's room socket path, `/<process>/<room>` (the same match its transport makes). */
const ROOM_PATH = /\/[a-zA-Z0-9_-]+\/([a-zA-Z0-9_-]+)$/;
/** Methods that name a room: their failures are guesses. */
const LOOKUPS = new Set(['joinById', 'reconnect']);

type Invoke = typeof matchMaker.controller.invokeMethod;

/**
 * @param roomId The room a `reconnect` names.
 * @param token Its reconnection token.
 * @returns True when a room of ours in this process holds a seat for that token.
 */
function holdsSeat(roomId: string, token: unknown): boolean {
  if (typeof token !== 'string') return false;
  const room = matchMaker.getLocalRoomById(roomId) as Partial<SeatHolder> | undefined;
  return typeof room?.holdsSeat === 'function' && room.holdsSeat(token);
}

/**
 * @param roomId The room a `joinById` names.
 * @param game The game the page says it runs.
 * @throws {ServerError} Colyseus's own "not found" when no room has that id, or its game is another.
 */
async function sameGame(roomId: string, game: unknown): Promise<void> {
  const listings = await matchMaker.query({ roomId });
  if (listings.length === 0 || listings[0].name !== game)
    throw new ServerError(NO_SUCH_ROOM, `room "${roomId}" not found`);
}

/** What `holdsSeat` asks a local room (`GameableColyseusRoom.holdsSeat`). */
interface SeatHolder {
  holdsSeat(token: string): boolean;
}

/**
 * The gate. `install()` wraps Colyseus's `controller.invokeMethod` (one per
 * process, like the matchmaker), so for **every** method, `reconnect` and
 * `joinById` included:
 *
 * 1. a page origin the policy refuses gets the same 403, before any lookup;
 * 2. a lookup from an address (or a process) out of failed lookups gets 429,
 *    except a `reconnect` whose token holds a seat in that room, which always
 *    passes and is never charged;
 * 3. a `joinById` whose `game` is not that room's game gets Colyseus's own
 *    "not found", charged as a miss: another game's code is a wrong code;
 * 4. the call runs with its address in scope, so a room it creates is charged
 *    to that address (`chargeCreate`, from the registry), and its join options
 *    carry the address (`PEER_OPTION`) for the lobby's socket count.
 *
 * `checkUpgrade` is the WebSocket transport's `beforeUpgrade`: origin, then a
 * reserved seat always passes, and only an upgrade naming no seat this process
 * holds is refused (429) or charged.
 *
 * @example
 * ```ts
 * import { createOriginPolicy, RequestGate } from 'gameable/rooms/server';
 *
 * const gate = new RequestGate(createOriginPolicy(['https://play.example']), {}, 1);
 * gate.install();
 * gate.uninstall();
 * ```
 */
export class RequestGate {
  readonly limits: AddressLimits;
  private readonly scope = new AsyncLocalStorage<string>();
  private original: PropertyDescriptor | null = null;
  private warnedForwarded = false;

  /**
   * @param policy The allowed page origins.
   * @param limits The limits.
   * @param hops Trusted proxies in front of the server (`clientIpOf`); 0 for none.
   */
  constructor(
    private readonly policy: OriginPolicy,
    limits: GateLimits,
    private readonly hops: number,
  ) {
    if (!Number.isInteger(hops) || hops < 0)
      throw new Error(`RequestGate: trustProxy is a hop count from 0, not ${String(hops)}`);
    this.limits = new AddressLimits(limits);
  }

  /** Wrap the matchmaker's controller. */
  install(): void {
    if (this.original !== null) return;
    const controller = matchMaker.controller;
    this.original = Object.getOwnPropertyDescriptor(controller, 'invokeMethod') ?? null;
    const original: Invoke = controller.invokeMethod.bind(controller);
    controller.invokeMethod = (method, roomName, options = {}, auth) =>
      this.pass(method, roomName, options as Record<string, unknown>, auth, () =>
        original(method, roomName, options, auth),
      );
  }

  /** Put the controller back. */
  uninstall(): void {
    if (this.original === null) return;
    Object.defineProperty(matchMaker.controller, 'invokeMethod', this.original);
    this.original = null;
  }

  /**
   * Charge a create to the address in scope; a create from the server itself is free.
   *
   * @returns The address it was charged to (give it back with `releaseCreate`), or undefined.
   * @throws {ServerError} 429 when that address holds its live rooms or created too many lately.
   */
  chargeCreate(): string | undefined {
    const key = this.scope.getStore();
    if (key === undefined) return undefined;
    const refused = this.limits.create(key);
    if (refused !== null) throw new ServerError(TOO_MANY, refused);
    return key;
  }

  /** @param owner The address a gone room was charged to. */
  releaseCreate(owner: string): void {
    this.limits.roomGone(owner);
  }

  /**
   * The transport's `beforeUpgrade`.
   *
   * @param request The upgrade request (its URL is built from the client's Host header).
   * @returns A refusal, or undefined to let the upgrade through.
   */
  checkUpgrade(request: Request): Response | undefined {
    const headers = request.headers;
    if (!this.policy.allows(headers.get('origin'))) return new Response(null, { status: FORBIDDEN });
    // The path the socket asked for, from the raw request line: Request.url trusts the Host header.
    const url = new URL(headers.get(PATH_HEADER) ?? '/', 'http://raw');
    const sessionId = url.searchParams.get('sessionId');
    const roomId = ROOM_PATH.exec(url.pathname)?.[1] ?? null;
    if (sessionId === null && roomId === null) return undefined; // Colyseus's ping utility: no lookup
    const room = roomId === null ? undefined : matchMaker.getLocalRoomById(roomId);
    const token = url.searchParams.get('reconnectionToken') ?? undefined;
    // A reserved seat always passes: someone else's guesses never lock a player out.
    if (room !== undefined && sessionId !== null && room.hasReservedSeat(sessionId, token)) return undefined;
    const key = this.keyOf(headers);
    if (!this.limits.canLookup(key)) return new Response(null, { status: TOO_MANY });
    this.limits.missed(key);
    return undefined;
  }

  /**
   * Node's `request` and `upgrade` listener, prepended to the HTTP server: it
   * writes the socket's peer address into `PEER_HEADER` and the raw path into
   * `PATH_HEADER`, over anything the client sent.
   *
   * @param req The request.
   */
  readonly stampPeer = (req: IncomingMessage): void => {
    req.headers[PEER_HEADER] = req.socket.remoteAddress ?? '';
    req.headers[PATH_HEADER] = req.url ?? '/';
  };

  private async pass(
    method: string,
    roomName: string,
    options: Record<string, unknown>,
    auth: AuthContext | undefined,
    call: () => Promise<unknown>,
  ): Promise<unknown> {
    if (auth === undefined) return call(); // the server's own call: no request
    if (!this.policy.allows(auth.headers.get('origin')))
      throw new ServerError(FORBIDDEN, 'this page origin may not use the room server');
    const key = this.keyOf(auth.headers);
    options[PEER_OPTION] = key;
    if (roomName === LOBBY_ROOM && !this.limits.canJoinLobby(key))
      throw new ServerError(TOO_MANY, 'this address holds the most lobby sockets it may');
    // A held seat's own token always passes, unmetered: someone else's guesses never lock a player out.
    if (method === 'reconnect' && holdsSeat(roomName, options.reconnectionToken)) return this.scope.run(key, call);
    const lookup = LOOKUPS.has(method) || options.code !== undefined;
    if (lookup && !this.limits.canLookup(key))
      throw new ServerError(TOO_MANY, 'too many failed room lookups; wait and try again');
    try {
      if (method === 'joinById') await sameGame(roomName, options.game);
      return await this.scope.run(key, call);
    } catch (error) {
      const code = (error as { code?: unknown }).code;
      if (lookup && code !== TOO_MANY) this.limits.missed(key);
      throw error;
    }
  }

  /**
   * @param headers A request's headers.
   * @returns Its limit key; warns once when forwarding headers arrive with `trustProxy` 0.
   */
  private keyOf(headers: Headers): string {
    if (this.hops === 0 && !this.warnedForwarded && headers.has('x-forwarded-for')) {
      this.warnedForwarded = true;
      console.warn(
        '[rooms] requests carry X-Forwarded-For but trustProxy is 0: every client behind that ' +
          'proxy shares one limit key. Set trustProxy to the number of proxies in front.',
      );
    }
    return clientIpOf(headers, this.hops);
  }
}
