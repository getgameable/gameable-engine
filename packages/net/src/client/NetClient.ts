/**
 * `NetClient` — the `NetService` over one `RoomConnection`.
 *
 * Frames are parsed when they arrive and queued; nothing reaches the engine
 * until the client loop drains the queues inside a fixed step.
 */
import type { Command } from '@gameable/sdk';

import { INPUT_FRAME_BYTES, MAX_CLIENT_TEXT_BYTES } from '../protocol/constants.js';
import { InputCodec } from '../protocol/InputCodec.js';
import { TextFrames } from '../protocol/TextFrames.js';
import type { InputSnapshotLike, PlayerSummary, ServerText } from '../protocol/types.js';
import { ClientQueues, type QueuedCounts } from './ClientQueues.js';
import { LinkWatch } from './LinkWatch.js';
import { NeutralInput } from './NeutralInput.js';
import type { NetClientOptions } from './NetClientOptions.js';
import { emptyNetStats } from './netStats.js';
import type {
  FramedRowSink,
  NetMessageSink,
  NetService,
  NetState,
  NetStats,
} from './NetService.js';
import type { ConnectionState, RoomConnection, RoomConnectionEvents } from './RoomConnection.js';
import { isWarningError } from './sessionErrors.js';
import { welcomeCommands } from './welcomeCommands.js';

/** The `net` service. Construct it through {@link createNetClient}; call `start` to join. */
export class NetClient implements NetService {
  state: NetState = 'connecting';
  room: string | null = null;
  closeReason = '';
  lastWarning = '';
  localPlayer = -1;
  localEntity = 0;
  players: readonly PlayerSummary[] = [];
  rtt = 0;
  frame = 0;
  welcomes = 0;
  readonly maxPlayers: number;
  readonly sendHz: number;
  readonly stats: NetStats = emptyNetStats();

  private readonly frames = new TextFrames();
  private readonly codec = new InputCodec();
  private readonly inputBytes = new Uint8Array(INPUT_FRAME_BYTES);
  private readonly inputView = new DataView(this.inputBytes.buffer);
  private readonly queues: ClientQueues;
  private readonly now: () => number;
  private readonly link: LinkWatch;
  private readonly neutral = new NeutralInput();
  private readonly listeners = new Set<() => void>();
  private cmdAck = 0;
  private badText = 0;
  private started = false;
  private heard = '';

  /**
   * @param connection The link to the room.
   * @param options Who joins, and where.
   */
  constructor(
    private readonly connection: RoomConnection,
    private readonly options: NetClientOptions = {},
  ) {
    this.maxPlayers = options.maxPlayers ?? 8;
    this.sendHz = options.sendHz ?? 20;
    this.now = options.now ?? (() => performance.now());
    this.link = new LinkWatch(options.silenceMs ?? 2_000);
    this.queues = new ClientQueues(this.sendHz, () => {
      this.stats.resyncs += 1;
    });
  }

  /** @returns How full the inbound queues are (diagnostics and tests). */
  get queued(): QueuedCounts {
    return this.queues.counts;
  }

  /** @returns The last input `seq` the authority applied; it can go backwards after a reconnect. */
  get ack(): number {
    return this.cmdAck;
  }

  /** Join the room. Further calls do nothing; the client loop calls it once it is attached. */
  start(): void {
    if (this.started) return;
    this.started = true;
    const request = { name: this.options.name ?? 'player' };
    this.connection.join(
      this.options.room === undefined ? request : { ...request, room: this.options.room },
      this.events,
    );
  }

  send(name: string, payload: unknown): boolean {
    const json = payload === undefined ? 'null' : (JSON.stringify(payload) as string | undefined);
    return json !== undefined && this.sendJson(name, json);
  }

  sendJson(name: string, json: string): boolean {
    if (this.state !== 'joined') return false;
    const text = `{"t":"msg","name":${JSON.stringify(name)},"payload":${json}}`;
    if (this.frames.byteLength(text) > MAX_CLIENT_TEXT_BYTES) return false;
    this.connection.sendText(text);
    return true;
  }

  sendInput(seq: number, snapshot: InputSnapshotLike): boolean {
    if (this.state !== 'joined') return false;
    if (this.codec.encode(this.inputView, seq, snapshot) !== INPUT_FRAME_BYTES) return false;
    this.connection.sendInput(this.inputBytes);
    this.stats.inputsSent += 1;
    this.neutral.remember(seq, snapshot);
    return true;
  }

  /**
   * Send one INPUT frame with nothing held and `focused: false`, at once and
   * outside any fixed step: the page is going away (hidden, blurred, closed),
   * and the room keeps applying the last input it had until the next one.
   * What was held comes up as `released` edges.
   *
   * @returns True when the frame went out (joined only).
   */
  releaseInput(): boolean {
    if (this.state !== 'joined') return false;
    const neutral = this.neutral;
    if (this.codec.encode(this.inputView, neutral.seq, neutral.snapshot) !== INPUT_FRAME_BYTES)
      return false;
    this.connection.sendInput(this.inputBytes);
    this.stats.inputsSent += 1;
    neutral.sent();
    return true;
  }

  /**
   * One fixed step of the link's health, from the `net` module: the resync
   * an overflow asked for, and the reconnect after `silenceMs` of steps with
   * no server frame. Steps, not wall-clock time: a hidden tab runs none, so a
   * tab coming back is not taken for a dead link.
   *
   * @param dtMs The fixed step, in ms.
   */
  watch(dtMs: number): void {
    const action = this.link.step(dtMs, this.state === 'joined', this.queues.overflowed);
    if (action === null) return;
    if (action === 'silent') this.stats.silences += 1;
    this.connection.reconnect(action);
  }

  /**
   * @param listener Called when `state`, `room` or `closeReason` changes, as
   *   the frame that changed it arrives (no fixed step needed).
   * @returns A function that removes the listener.
   */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  ping(): void {
    if (this.state === 'joined')
      this.connection.sendText(`{"t":"ping","at":${String(this.now())}}`);
  }

  drainCommands(sink: (command: Command) => void): void {
    this.queues.drainCommands(sink);
  }

  drainRows(sink: FramedRowSink): void {
    const rows = this.queues.rows;
    this.queues.drainRows(sink);
    this.stats.staleRows = rows.stale;
    this.stats.rowsFrames = rows.applied;
    this.stats.badFrames = this.badText + rows.bad;
  }

  drainMessages(sink: NetMessageSink): void {
    this.queues.drainMessages(sink);
  }

  leave(reason = 'left'): void {
    this.connection.leave(reason);
  }

  /** What the connection reports, bound once. */
  private readonly events: RoomConnectionEvents = {
    onText: (text) => {
      this.link.heard();
      const frame = this.frames.parseServer(text);
      if (frame === null) {
        this.badText += 1;
        this.stats.badFrames = this.badText + this.queues.rows.bad;
      } else this.receive(frame);
      this.changed();
    },
    onRows: (bytes) => {
      this.link.heard();
      this.queues.pushRows(bytes);
      this.stats.badFrames = this.badText + this.queues.rows.bad;
    },
    onState: (state: ConnectionState, reason: string) => {
      if (state === 'reconnecting') this.state = 'reconnecting';
      else if (state === 'closed') {
        this.state = 'closed';
        if (this.closeReason === '') this.closeReason = reason;
      }
      this.changed();
    },
  };

  /** Tell the listeners, when `state`, `room`, `closeReason` or `lastWarning` moved since the last time. */
  private changed(): void {
    if (this.listeners.size === 0) return;
    const now = `${this.state}\n${this.room ?? ''}\n${this.closeReason}\n${this.lastWarning}`;
    if (now === this.heard) return;
    this.heard = now;
    for (const listener of this.listeners) listener();
  }

  /** @param frame One parsed server frame. */
  private receive(frame: ServerText): void {
    switch (frame.t) {
      case 'welcome':
        // Whatever was queued belongs to the world this welcome replaces,
        // authority messages included: a welcome is a new start, and a
        // message from before it is lost (documented in the README).
        this.link.welcomed();
        this.room = frame.room ?? this.room;
        welcomeCommands(frame.snapshot, frame.player, this.queues.restart(frame.frame));
        this.localPlayer = frame.player;
        this.localEntity = frame.entity;
        this.players = frame.players;
        this.frame = frame.frame;
        this.welcomes += 1;
        this.state = 'joined';
        return;
      case 'cmd':
        this.stats.commandFrames += 1;
        this.frame = frame.frame;
        this.cmdAck = frame.ack;
        this.localEntity = frame.entity;
        this.queues.pushCommands(frame.commands);
        return;
      case 'players':
        this.players = frame.players;
        return;
      case 'msg':
        this.stats.messages += 1;
        this.queues.pushMessage({
          from: frame.from,
          name: frame.name,
          payload: JSON.stringify(frame.payload),
        });
        return;
      case 'pong':
        this.rtt = this.now() - frame.at;
        return;
      case 'error':
        if (isWarningError(frame.code)) {
          this.lastWarning = frame.code;
          this.stats.warnings += 1;
          return;
        }
        this.closeReason =
          frame.detail === undefined ? frame.code : `${frame.code}: ${frame.detail}`;
        return;
    }
  }
}

/**
 * The `net` service over a connection.
 *
 * @param connection The link to the room.
 * @param options Who joins, and where.
 * @returns The service; call `start()` to join.
 *
 * @example
 * ```ts
 * import { createLoopbackConnection, createNetClient } from 'gameable/net/client';
 * import { loopbackPair } from 'gameable/net/testing';
 *
 * const net = createNetClient(createLoopbackConnection({ connect: () => loopbackPair()[0] }), { name: 'Ana' });
 * net.start();
 * ```
 */
export function createNetClient(connection: RoomConnection, options?: NetClientOptions): NetClient {
  return new NetClient(connection, options);
}
