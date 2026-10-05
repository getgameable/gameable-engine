/**
 * `LoopbackConnection` — a `RoomConnection` that speaks our own frames over
 * a `Transport`, to our own `Room`: Play Solo's in-page room, and tests.
 *
 * It sends the `hello`, keeps the seat the `welcome` names, and when the link
 * drops it opens a fresh transport and resumes the seat with its secret. A
 * server `error` frame (`full`, `seat`, `version`, `ended`, ...) ends it.
 */
import { PROTOCOL_VERSION } from '../protocol/constants.js';
import { buildClientText } from '../protocol/textFrameFunctions.js';
import type { Transport, TransportData } from '../transport/Transport.js';
import { isWarningError } from './sessionErrors.js';
import type {
  ConnectionState,
  JoinRequest,
  RoomConnection,
  RoomConnectionEvents,
} from './RoomConnection.js';

/** A one-shot timer, so tests and pages can supply their own clock. */
export interface ConnectionTimers {
  /** Run `fn` once after `ms`; returns a handle for `clearTimer`. */
  setTimer(fn: () => void, ms: number): unknown;
  /** Cancel a timer from `setTimer`. */
  clearTimer(handle: unknown): void;
}

/**
 * Options for {@link createLoopbackConnection}.
 *
 * @example
 * ```ts
 * import type { LoopbackConnectionOptions } from 'gameable/net/client';
 * import { loopbackPair } from 'gameable/net/testing';
 * const options: LoopbackConnectionOptions = { connect: () => loopbackPair()[0], room: 'SOLO' };
 * ```
 */
export interface LoopbackConnectionOptions {
  /** Open a fresh transport to the room: called on join and on every retry. */
  connect(): Transport;
  /** The room code the `hello` names when the join request has none. Defaults to `'solo'`. */
  room?: string;
  /** Retry delays: `baseMs` x attempt, at most `maxMs`, up to `attempts` tries. Defaults 400, 4,000, 10. */
  backoff?: { baseMs?: number; maxMs?: number; attempts?: number };
  /** Timers for the retries. Defaults to `setTimeout`. */
  timers?: ConnectionTimers;
}

const WELCOME_PREFIX = '{"t":"welcome"';
const ERROR_PREFIX = '{"t":"error"';
const DEFAULT_TIMERS: ConnectionTimers = {
  setTimer: (fn, ms) => setTimeout(fn, ms),
  clearTimer: (handle) => {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
};

/**
 * @param text JSON text.
 * @returns It parsed, or null when it is not JSON (the client's parser counts it as bad).
 */
function parseOrNull(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

/** A seat to resume: what the `welcome` named. */
interface Seat {
  id: number;
  secret: string;
}

/** The loopback `RoomConnection`. Construct it through {@link createLoopbackConnection}. */
export class LoopbackConnection implements RoomConnection {
  private current: ConnectionState = 'idle';
  private code: string | null = null;
  private transport: Transport | null = null;
  private events: RoomConnectionEvents | null = null;
  private request: JoinRequest = { name: '' };
  private seat: Seat | null = null;
  private refusal: string | null = null;
  private attempts = 0;
  private timer: unknown = null;
  private readonly timers: ConnectionTimers;

  /** @param options How to reach the room. */
  constructor(private readonly options: LoopbackConnectionOptions) {
    this.timers = options.timers ?? DEFAULT_TIMERS;
  }

  get state(): ConnectionState {
    return this.current;
  }

  get room(): string | null {
    return this.code;
  }

  join(request: JoinRequest, events: RoomConnectionEvents): void {
    if (this.current !== 'idle') throw new Error('LoopbackConnection.join: call it once');
    this.request = request;
    this.events = events;
    this.move('connecting', '');
    this.open();
  }

  sendInput(bytes: Uint8Array): void {
    // The loopback and socket transports copy binary frames on send.
    if (this.current === 'open') this.transport?.send(bytes);
  }

  sendText(text: string): void {
    if (this.current === 'open') this.transport?.send(text);
  }

  reconnect(reason: string): void {
    if (this.current !== 'open') return;
    const transport = this.transport;
    this.transport = null; // its close is ours: `lost` runs once, here
    transport?.close(reason);
    this.lost(reason);
  }

  leave(reason = 'left'): void {
    if (this.current === 'closed') return;
    this.cancelRetry();
    const transport = this.transport;
    this.transport = null;
    transport?.close(reason);
    this.move('closed', reason);
  }

  /** Open a transport and say hello, resuming the seat when there is one. */
  private open(): void {
    const transport = this.options.connect();
    this.transport = transport;
    transport.onMessage((data) => {
      if (this.transport === transport) this.receive(data);
    });
    transport.onClose((reason) => {
      if (this.transport === transport) this.lost(reason);
    });
    const hello = buildClientText({
      t: 'hello',
      v: PROTOCOL_VERSION,
      room: this.request.room ?? this.options.room ?? 'solo',
      name: this.request.name,
      ...(this.seat === null ? {} : { seat: this.seat }),
    });
    if (hello !== null) transport.send(hello);
  }

  /** @param data One frame from the room. */
  private receive(data: TransportData): void {
    const events = this.events;
    if (events === null) return;
    if (typeof data !== 'string') {
      events.onRows(data);
      return;
    }
    // Only these two frames concern the connection, and our room writes
    // them with `t` first; everything else passes through unread.
    if (data.startsWith(WELCOME_PREFIX)) {
      this.welcomed(data);
      events.onText(data);
      this.attempts = 0;
      this.move('open', '');
      return;
    }
    if (data.startsWith(ERROR_PREFIX)) this.refused(data);
    events.onText(data);
  }

  /** @param text A `welcome`: keep its seat for a resume. */
  private welcomed(text: string): void {
    const frame = parseOrNull(text) as {
      player?: unknown;
      secret?: unknown;
      room?: unknown;
    } | null;
    if (frame === null) return;
    if (typeof frame.player === 'number' && typeof frame.secret === 'string') {
      this.seat = { id: frame.player, secret: frame.secret };
    }
    if (typeof frame.room === 'string') this.code = frame.room;
  }

  /**
   * @param text An `error`: the room said no, so no retry follows the close.
   *   A warning (`isWarningError`: `budget`) is not a refusal; the seat is kept.
   */
  private refused(text: string): void {
    const frame = parseOrNull(text) as { code?: unknown } | null;
    const code = typeof frame?.code === 'string' ? frame.code : 'error';
    if (!isWarningError(code)) this.refusal = code;
  }

  /** @param reason Why the transport closed. */
  private lost(reason: string): void {
    this.transport = null;
    if (this.current === 'closed') return;
    const backoff = this.options.backoff ?? {};
    // The room dropping the page for abuse (`budget`) is final too: its seat is gone.
    if (this.refusal === null && reason === 'budget') this.refusal = reason;
    if (this.refusal !== null || this.attempts >= (backoff.attempts ?? 10)) {
      this.move('closed', this.refusal ?? reason);
      return;
    }
    this.attempts += 1;
    this.move('reconnecting', reason);
    const delay = Math.min((backoff.baseMs ?? 400) * this.attempts, backoff.maxMs ?? 4_000);
    this.timer = this.timers.setTimer(() => {
      this.timer = null;
      if (this.current === 'reconnecting') this.open();
    }, delay);
  }

  private cancelRetry(): void {
    if (this.timer === null) return;
    this.timers.clearTimer(this.timer);
    this.timer = null;
  }

  /**
   * @param state The new state.
   * @param reason Why.
   */
  private move(state: ConnectionState, reason: string): void {
    if (this.current === state) return;
    this.current = state;
    this.events?.onState(state, reason);
  }
}

/**
 * A connection that speaks our own frames to our own `Room` over a
 * `Transport`: Play Solo, and tests.
 *
 * @param options How to open a transport to the room, and how to retry.
 * @returns The connection; call `join` to start.
 *
 * @example
 * ```ts
 * import { createLoopbackConnection } from 'gameable/net/client';
 * import { loopbackPair } from 'gameable/net/testing';
 *
 * const connection = createLoopbackConnection({
 *   connect: () => loopbackPair()[0],
 *   backoff: { baseMs: 200 },
 * });
 * ```
 */
export function createLoopbackConnection(options: LoopbackConnectionOptions): LoopbackConnection {
  return new LoopbackConnection(options);
}
