/**
 * `ColyseusConnection` — a `RoomConnection` to the Colyseus room server
 * (`gameable/rooms/server`), on `@colyseus/sdk` and `GameableClientSerializer`.
 *
 * Joining: a code joins that room (`joinById`), no code is a quick match
 * (`joinOrCreate`), and `create` makes a fresh room. Before a join by code it
 * tries this tab's saved reconnection token for that room (`SeatClaim`), so a
 * reload gets its seat back, unless another live tab holds that seat's lock
 * (a duplicated tab), which then joins as a new player. A dropped link is the
 * SDK's own resume, with its capped backoff; the room's next welcome reopens
 * it and its token is saved then.
 *
 * Every join also sends this browser's device token (`DeviceTokens`, in
 * `localStorage`) and, when the page has one, a Gameable session token
 * (`portalToken`); a token the room mints (`IDENTITY_TYPE`) is kept.
 *
 * Sends are dropped unless the state is `open`, and the SDK's offline queue
 * is off (`maxEnqueuedMessages = 0`), so nothing sent before a welcome is
 * replayed into the room after it.
 */
import type {
  ConnectionState,
  JoinRequest,
  RoomConnection,
  RoomConnectionEvents,
} from '@gameable/net/client';
import { PROTOCOL_VERSION } from '@gameable/net';
import { Client, CloseCode, type Room } from '@colyseus/sdk';

import { IDENTITY_TYPE, INPUT_TYPE, TEXT_TYPE } from '../channels.js';
import { GameableClientSerializer, type GameableFrameSink } from './GameableClientSerializer.js';
import { DeviceTokens } from './DeviceTokens.js';
import { leaveReason, refusalReason } from './reasons.js';
import { SeatClaim } from './SeatClaim.js';
import type { SeatLocks } from './SeatLocks.js';
import type { SeatStorage } from './SeatTokens.js';

/**
 * Options for {@link createColyseusConnection}.
 *
 * @example
 * ```ts
 * import type { ColyseusConnectionOptions } from 'gameable/rooms/client';
 * const options: ColyseusConnectionOptions = { url: 'wss://play.example/services/rooms/', game: 'party' };
 * ```
 */
export interface ColyseusConnectionOptions {
  /** The room server: `wss://host/services/rooms/` (http and https map to ws and wss). */
  readonly url: string;
  /** The game's name in the server's catalog. */
  readonly game: string;
  /** Make a fresh room instead of joining one ("new room"). */
  readonly create?: boolean;
  /** With `create`: leave the room out of public listings; it is joined by its code only. */
  readonly private?: boolean;
  /** Where reconnection tokens live. Default this tab's `sessionStorage`; null keeps none. */
  readonly storage?: SeatStorage | null;
  /** Where the device token lives (`DeviceTokens`). Default `localStorage`; null keeps none: every join is a new device. */
  readonly deviceStorage?: SeatStorage | null;
  /**
   * A Gameable session token, asked at each join, for a page the session
   * cookie does not reach (a domain outside the auth service's cookie domain). It travels in
   * the join request's body. Default none: the browser's cookie, if any.
   */
  readonly portalToken?: () => string | null;
  /** Seat locks shared by the browser's tabs. Default `navigator.locks`; null takes none (the server still refuses a live seat's token). */
  readonly locks?: SeatLocks | null;
  /** The SDK's `minUptime`: a drop sooner than this after joining closes instead of resuming. Default 0: every drop resumes, with the SDK's capped backoff. */
  readonly minUptimeMs?: number;
  /** HTTP and upgrade headers, for Node (a test's `origin`); a browser sends its own Origin. */
  readonly headers?: Readonly<Record<string, string>>;
}

/** The code at the head of our welcome: `{"t":"welcome","room":"KQTX",...`. */
const WELCOME_ROOM = /^\{"t":"welcome","room":"([^"]*)"/;
/** The code of an `error` frame, as `GameableWire.error` writes it: `{"t":"error","code":"budget"...`. */
const ERROR_CODE = /^\{"t":"error","code":"([a-z-]{1,16})"/;

/** The Colyseus `RoomConnection`. Construct it through {@link createColyseusConnection}. */
export class ColyseusConnection implements RoomConnection {
  private current: ConnectionState = 'idle';
  private code: string | null = null;
  /** The last `error` frame's code: why a 4002 close that follows it happened. */
  private said: string | undefined = undefined;
  private sdkRoom: Room | null = null;
  private events: RoomConnectionEvents | null = null;
  private readonly claim: SeatClaim;
  private readonly device: DeviceTokens;
  private readonly encoder = new TextEncoder();

  /** @param options The server, the game, and how to join. */
  constructor(private readonly options: ColyseusConnectionOptions) {
    this.claim = new SeatClaim(options.url, options.game, options.storage, options.locks);
    this.device = new DeviceTokens(options.url, options.deviceStorage);
  }

  get state(): ConnectionState {
    return this.current;
  }

  get room(): string | null {
    return this.code;
  }

  /** @returns The SDK's room while joined (diagnostics and tests), else null. */
  get colyseusRoom(): Room | null {
    return this.sdkRoom;
  }

  join(request: JoinRequest, events: RoomConnectionEvents): void {
    if (this.current !== 'idle') throw new Error('ColyseusConnection.join: call it once');
    this.events = events;
    this.move('connecting', '');
    void this.start(request);
  }

  sendInput(bytes: Uint8Array): void {
    // No copy: `sendBytes` copies into the SDK's own buffer before it returns.
    if (this.current === 'open') this.sdkRoom?.sendBytes(INPUT_TYPE, bytes);
  }

  sendText(text: string): void {
    if (this.current === 'open') this.sdkRoom?.sendBytes(TEXT_TYPE, this.encoder.encode(text));
  }

  /**
   * Close the socket with `MAY_TRY_RECONNECT` (4010): the SDK runs its own
   * resume at once, on this tab's token, and the room's next welcome reopens
   * the connection. The server holds the seat meanwhile.
   *
   * @param reason Why, as the close frame carries it.
   */
  reconnect(reason: string): void {
    if (this.current !== 'open') return;
    this.sdkRoom?.connection.close(CloseCode.MAY_TRY_RECONNECT, reason);
  }

  leave(reason = 'left'): void {
    if (this.current === 'closed') return;
    const room = this.sdkRoom;
    this.move('closed', reason);
    if (room === null) return; // still joining: `start` leaves once the join lands
    if (this.code !== null) this.claim.forget(this.code);
    void room.leave(true);
  }

  /** @param request Who joins, and where. */
  private async start(request: JoinRequest): Promise<void> {
    const code = request.room?.trim().toUpperCase() ?? '';
    let room: Room;
    try {
      room =
        (code === '' ? null : await this.resume(code)) ?? (await this.enter(code, request.name));
    } catch (error) {
      this.move('closed', refusalReason(error));
      return;
    }
    if (this.current === 'closed') {
      this.claim.unlock();
      void room.leave(true); // left while joining
      return;
    }
    this.bind(room);
    await this.claim.hold(room.roomId, room.sessionId);
  }

  /**
   * @param code A room code.
   * @returns The seat this tab held there, by its saved token, or null.
   */
  private async resume(code: string): Promise<Room | null> {
    if (this.options.create === true) return null;
    const saved = await this.claim.resumable(code);
    if (saved === null) return null;
    try {
      return await this.client().reconnect(saved.token);
    } catch {
      this.claim.forget(code); // expired, gone, or refused (a live seat's token): join as a new player
      this.claim.unlock();
      return null;
    }
  }

  /**
   * @param code A room code, or '' for a quick match.
   * @param name The display name.
   * @returns The joined room.
   */
  private enter(code: string, name: string): Promise<Room> {
    const client = this.client();
    const { game, create } = this.options;
    // Every join names its game and our protocol version: the room refuses a
    // code from another game, and a page older than the server (GameableColyseusRoom.onAuth).
    const options = { name, game, v: PROTOCOL_VERSION, ...this.identity() };
    if (create === true)
      return client.create(game, { ...options, private: this.options.private === true });
    return code === '' ? client.joinOrCreate(game, options) : client.joinById(code, options);
  }

  /** @returns Who this page is: its device token, and a session token if the page has one. */
  private identity(): { device?: string; portal?: string } {
    const device = this.device.load();
    const portal = this.options.portalToken?.() ?? null;
    return { ...(device === null ? {} : { device }), ...(portal ? { portal } : {}) };
  }

  /** @returns A fresh SDK client for one matchmaking call. */
  private client(): Client {
    const headers = this.options.headers;
    return new Client(
      this.options.url,
      headers === undefined ? undefined : { headers: { ...headers } },
    );
  }

  /** @param room A room just joined (or resumed by token): wire it to our events. */
  private bind(room: Room): void {
    const serializer: unknown = room.serializer;
    if (!(serializer instanceof GameableClientSerializer)) {
      void room.leave(true);
      this.move('closed', 'serializer');
      return;
    }
    this.sdkRoom = room;
    this.code = room.roomId;
    room.reconnection.maxEnqueuedMessages = 0; // never replay a queue before the welcome
    room.reconnection.minUptime = this.options.minUptimeMs ?? 0;
    room.onDrop(() => {
      this.move('reconnecting', 'lost');
    });
    room.onMessage(IDENTITY_TYPE, (token: unknown) => {
      if (typeof token === 'string') this.device.save(token);
    });
    // The token is saved at each welcome, never in onReconnect: the SDK fires
    // that before it stores the token the server just issued.
    room.onLeave((code: number) => {
      if (code === CloseCode.CONSENTED) this.claim.forget(room.roomId);
      this.claim.unlock();
      this.move('closed', leaveReason(code, this.said));
    });
    serializer.attach(this.sink);
  }

  /** Our frames from the serializer, bound once. */
  private readonly sink: GameableFrameSink = {
    welcome: (text) => {
      this.code = WELCOME_ROOM.exec(text)?.[1] ?? this.code;
      const room = this.sdkRoom;
      if (room !== null) {
        this.claim.save(room.roomId, { sessionId: room.sessionId, token: room.reconnectionToken });
      }
      this.events?.onText(text);
      this.move('open', '');
    },
    text: (text) => {
      if (text.startsWith('{"t":"error"')) this.said = ERROR_CODE.exec(text)?.[1] ?? this.said;
      this.events?.onText(text);
    },
    rows: (bytes) => this.events?.onRows(bytes),
  };

  /**
   * @param state The new state.
   * @param reason Why.
   */
  private move(state: ConnectionState, reason: string): void {
    if (this.current === state || this.current === 'closed') return;
    this.current = state;
    this.events?.onState(state, reason);
  }
}

/**
 * A connection to a Colyseus room server.
 *
 * @param options The server, the game, and how to join.
 * @returns The connection; `multiplayer()` (or `NetClient.start`) calls `join`.
 *
 * @example
 * ```ts
 * import { createColyseusConnection } from 'gameable/rooms/client';
 * import { createNetClient } from 'gameable/net/client';
 *
 * const connection = createColyseusConnection({ url: 'wss://play.example/services/rooms/', game: 'party' });
 * const net = createNetClient(connection, { name: 'Ana', room: 'KQTX' });
 * net.start();
 * ```
 */
export function createColyseusConnection(options: ColyseusConnectionOptions): ColyseusConnection {
  return new ColyseusConnection(options);
}
