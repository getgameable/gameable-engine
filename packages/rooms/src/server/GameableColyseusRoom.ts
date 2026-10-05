/**
 * `GameableColyseusRoom` — one Colyseus room class for every game: our
 * authoritative `RoomGame` inside, Colyseus around it.
 */
import type { Identities, RoomGame } from '@gameable/net/server';
import { type AuthContext, type Client, Room, ServerError } from '@colyseus/core';

import { IDENTITY_TYPE, IDLE_CLOSE_CODE, INPUT_TYPE, TEXT_TYPE } from '../channels.js';
import type { GameableCreateOptions, GameableRoomOptions } from './GameableRoomEntry.js';
import { createAosSerializer } from './GameableSerializer.js';
import { IdleSeats } from './IdleSeats.js';
import { admitJoin, type GameableJoinOptions, checkJoin } from './RoomAdmission.js';
import { RoomCrash } from './RoomCrash.js';
import { identifyJoin, type SeatAuth } from './RoomIdentify.js';
import type { RoomIntake } from './RoomIntake.js';
import { RoomLifecycle } from './RoomLifecycle.js';
import { RoomListing } from './RoomListing.js';
import { advanceRoom, buildRoomParts, type RoomParts } from './RoomParts.js';
import type { SeatMap } from './SeatMap.js';
import { SeatQuota } from './SeatQuota.js';

const TICK_MS = 1000 / 60;
const MAX_MESSAGES_PER_SECOND = 200; // every client frame, Colyseus's own included; over it 4002, no hold
const CREATE_RESERVATION_SECONDS = 5; // a creator who never connects frees the room and slot in 5 s
const JOIN_RESERVATION_SECONDS = 15; // later joiners: Colyseus's default

/**
 * Our engine room on Colyseus (matchmaking, `maxClients`, the socket, reconnection). Ours: the
 * game, seats, budgets, replication at 60 Hz, slot and code (`RoomListing`) and failure
 * (`RoomCrash`, `RoomLifecycle`): a throw from the game closes this room alone, `crashed`.
 * A join must pass `admitJoin` (version, game, the game's `admit`) and is identified
 * (`identifyJoin`: the portal, then the device token), each address holds at most
 * `seatsPerAddress` seats (`SeatQuota`), and a client silent for `idleSeconds` is dropped
 * (`IdleSeats`) with its seat held.
 *
 * @example
 * ```ts
 * import { GameableColyseusRoom } from 'gameable/rooms/server';
 * import { Server } from '@colyseus/core';
 *
 * const server = new Server();
 * server.define('tiny', GameableColyseusRoom, { entry: { maxPlayers: 2, create: makeGame } });
 * ```
 */
export class GameableColyseusRoom extends Room {
  private parts: RoomParts | null = null;
  private readonly listing = new RoomListing(this);
  private readonly failure = new RoomCrash(this, () => this.parts?.replication ?? null);
  private readonly lifecycle = new RoomLifecycle(() => this.parts, this.failure, this.listing);
  private reconnectSeconds = 30;
  private ending = false;
  private quota = new SeatQuota(undefined);
  private idle: IdleSeats | null = null;
  private identities: Identities | null = null;

  /** @returns The game behind the seats. */
  get game(): RoomGame {
    return this.built().game;
  }

  /** @returns The seats, held ones included. */
  get seats(): SeatMap {
    return this.built().seats;
  }

  /** @returns Seats taken, held ones included; 0 while the room is being built. */
  get players(): number {
    return this.parts?.seats.size ?? 0;
  }

  /** @returns What came in and what was refused (tests, logs). */
  get intake(): RoomIntake {
    return this.built().inbound.intake;
  }

  async onCreate(options: GameableRoomOptions & GameableCreateOptions): Promise<void> {
    this.listing.claim(options);
    const parts = await buildRoomParts(options.entry, this.clients).catch((error: unknown) => {
      this.listing.release(error);
      throw error;
    });
    this.parts = parts;
    this.identities = options.identities ?? null;
    parts.replication.room = this.roomId;
    this.maxClients = options.entry.maxPlayers;
    this.maxMessagesPerSecond = MAX_MESSAGES_PER_SECOND;
    this.reconnectSeconds = options.entry.reconnectSeconds ?? 30;
    this.quota = new SeatQuota(options.limits);
    this.idle = new IdleSeats((options.entry.idleSeconds ?? 120) * 1000, (sessionId) => {
      this.clients.get(sessionId)?.leave(IDLE_CLOSE_CODE);
    });
    this.seatReservationTimeout = CREATE_RESERVATION_SECONDS;
    const flush = parts.replication.flush.bind(parts.replication);
    this.setSerializer(
      createAosSerializer({ welcomeFor: (c) => this.lifecycle.welcome(c), flush }),
    );
    this.state = {}; // a marker: Colyseus only sends full state and patches while a state is set
    this.onMessageBytes(INPUT_TYPE, (client: Client, bytes: Uint8Array) => {
      parts.inbound.input(client, bytes);
    });
    this.onMessageBytes(TEXT_TYPE, (client: Client, bytes: Uint8Array) => {
      parts.inbound.text(client, bytes);
    });
    if (options.private === true) await this.setPrivate(true);
    await this.listing.publish();
    // setFixedTimestep (not 44 Hz setSimulationInterval), before patchRate = null, after the awaits.
    const start = performance.now();
    this.setFixedTimestep((ctx) => {
      this.step(start + (ctx.tick + 1) * TICK_MS);
    }, 60);
    this.patchRate = null; // our step calls broadcastPatch() itself
  }

  /**
   * Before a seat is taken: the protocol version and this room's game
   * (`checkJoin`), who the player is (`identifyJoin`), then the game's
   * `admit` hook on the seat's name (`admitJoin`). A refusal reserves nothing.
   *
   * @param _client The client joining.
   * @param options Its join options.
   * @param context The upgrade request: its `Cookie` carries a Gameable session.
   * @returns The seat's name and identity: Colyseus keeps it as `client.auth`.
   */
  override async onAuth(
    _client: Client,
    options: GameableJoinOptions,
    context?: AuthContext,
  ): Promise<SeatAuth> {
    const game = this.parts?.game ?? null;
    checkJoin(this, game, options);
    const auth = await identifyJoin(this.identities, options, context?.headers);
    await admitJoin(this, game, options, auth.name);
    return auth;
  }

  onJoin(client: Client, options?: Record<string, unknown>): void {
    this.seatReservationTimeout = JOIN_RESERVATION_SECONDS;
    this.quota.take(client.sessionId, options); // 429 past the address's seats; onLeave follows
    const auth = client.auth as SeatAuth | undefined;
    this.lifecycle.join(client.sessionId, auth?.name ?? options?.name, auth?.identity ?? null);
    // Queued by Colyseus until the join is acked: the page has it right after its welcome.
    if (typeof auth?.minted === 'string') client.send(IDENTITY_TYPE, auth.minted);
  }

  onDrop(client: Client, code?: number): void {
    if (this.lifecycle.drop(client.sessionId, code))
      this.allowReconnection(client, this.reconnectSeconds).catch(() => undefined); // expiry: onLeave
  }

  onReconnect(client: Client): void {
    this.lifecycle.resume(client.sessionId);
  }

  onLeave(client: Client, code?: number): void {
    this.quota.release(client.sessionId);
    this.lifecycle.leave(client.sessionId, code);
  }

  /**
   * Colyseus's version force-closes a CONNECTED client whose token is
   * presented again (4002, which `RoomSeating` would read as `flood`) and
   * hands its seat over. A second tab with a copied token, or a stolen one,
   * would free a live player's seat. Here only a held seat resumes.
   *
   * @param token The reconnection token presented.
   * @returns The held seat's session, or '' (refused: the matchmaker answers 524).
   */
  override checkReconnectionToken(token: string): string {
    if (this.clients.some((c) => c.reconnectionToken === token)) return '';
    return super.checkReconnectionToken(token);
  }

  /**
   * Asked by the request gate before it meters a `reconnect`. No side effect:
   * a connected client's token is refused here (see `checkReconnectionToken`).
   *
   * @param token A reconnection token.
   * @returns True when it names a seat this room holds for a reconnect.
   */
  holdsSeat(token: string): boolean {
    const sessionId: string | undefined = this.checkReconnectionToken(token);
    return typeof sessionId === 'string' && sessionId !== '';
  }

  onDispose(): void {
    this.quota.dispose();
    this.lifecycle.dispose(`${this.roomId} (${this.roomName})`);
  }

  /**
   * Colyseus's catch (timestep, handlers, hooks). A failed onCreate is the
   * matchmaker's; onAuth only ever refuses; a `ServerError` from onJoin is a
   * refusal too (seats per address). Anything else crashes this room.
   *
   * @param error What was thrown, wrapped by Colyseus (the throw is its `cause`).
   * @param method Where.
   */
  onUncaughtException(error: Error, method: string): void {
    if (method === 'onCreate' || method === 'onAuth') return;
    if (method === 'onJoin' && error.cause instanceof ServerError) return;
    this.failure.crash(error, method);
  }

  /**
   * One tick, then every player's frames; a game that ended itself sends `error: ended` and the room goes.
   *
   * @param nowMs The room clock: whole fixed steps since the room was made.
   */
  step(nowMs: number): void {
    const parts = this.parts;
    if (this.ending || this.failure.crashed || parts === null) return;
    this.idle?.sweep(parts.seats, performance.now());
    const ended = advanceRoom(parts, nowMs);
    const { replication } = parts;
    this.listing.follow(parts.game.phase); // the room list's phase: re-listed only on a change
    if (ended === null) {
      this.broadcastPatch(); // -> GameableSerializer.applyPatches -> replication.flush()
      return;
    }
    this.ending = true;
    replication.sendAll(replication.wire.error('ended', ended === 'ended' ? undefined : ended));
    void this.disconnect();
  }

  private built(): RoomParts {
    if (this.parts === null) throw new Error('GameableColyseusRoom: used before onCreate');
    return this.parts;
  }
}
