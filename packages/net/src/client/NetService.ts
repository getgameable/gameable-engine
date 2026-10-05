/**
 * `NetService` — the page's view of its room: who it is, who else is there,
 * and the queues of what the authority sent, waiting for the next fixed step.
 */
import type { Command } from '@gameable/sdk';

import type { InputSnapshotLike, PlayerSummary, RowSink } from '../protocol/types.js';

/**
 * Where the page is in its room:
 *
 * - `connecting`: joining, no `welcome` yet;
 * - `joined`: the `welcome` arrived and frames flow;
 * - `reconnecting`: the link dropped and the seat is held while it retries;
 * - `closed`: the room is gone for this page (`closeReason` says why).
 *
 * @example
 * ```ts
 * import type { NetState } from 'gameable/net/client';
 * const playing = (state: NetState): boolean => state === 'joined';
 * ```
 */
export type NetState = 'connecting' | 'joined' | 'reconnecting' | 'closed';

/**
 * Counters since the service was made.
 *
 * @example
 * ```ts
 * import type { NetStats } from 'gameable/net/client';
 * const line = (s: NetStats): string => `stale ${String(s.staleRows)} / ${String(s.rowsFrames)}`;
 * ```
 */
export interface NetStats {
  /** Rows frames dropped because an older `frame` arrived after a newer one was applied. */
  staleRows: number;
  /** Rows frames applied. */
  rowsFrames: number;
  /** `cmd` frames received. */
  commandFrames: number;
  /** `msg` frames received from the authority. */
  messages: number;
  /** Frames that did not parse (text) or were not a rows frame (binary). */
  badFrames: number;
  /** INPUT frames sent. */
  inputsSent: number;
  /**
   * Times the inbound queues overflowed (about 3 s of frames that no fixed
   * step drained: a hidden tab) and were dropped for a fresh welcome.
   */
  resyncs: number;
  /** Times the link was dropped and resumed after 2 s of steps with no server frame. */
  silences: number;
  /** `error` frames that warned without ending the session (`lastWarning`). */
  warnings: number;
  /**
   * Times a predicting page's own body was more than 2 cm from where the
   * authority had it, and was put back and replayed. Always 0 without
   * `predict`.
   */
  corrections: number;
}

/**
 * A rows sink that is also told which authority frame the next rows describe.
 *
 * @example
 * ```ts
 * import type { FramedRowSink } from 'gameable/net/client';
 * const sink: FramedRowSink = {
 *   position: new Float32Array(3),
 *   rotation: new Float32Array(4),
 *   scale: new Float32Array(3),
 *   beginFrame: (frame) => console.log('rows of frame', frame),
 *   row: (entity) => console.log(entity),
 * };
 * ```
 */
export interface FramedRowSink extends RowSink {
  /** Called before each rows frame's rows, with that frame's `frame`. */
  beginFrame?(frame: number): void;
}

/**
 * A message from the authority, as the client loop hands it to the guest.
 *
 * @example
 * ```ts
 * import type { NetMessageSink } from 'gameable/net/client';
 * const log: NetMessageSink = (from, name, payload) => console.log(from, name, payload);
 * ```
 */
export type NetMessageSink = (from: number, name: string, payload: string) => void;

/**
 * The `net` service: what the page knows about its room, and the queues the
 * client loop drains once per fixed step.
 *
 * @example
 * ```ts
 * import type { NetService } from 'gameable/net/client';
 * declare const net: NetService;
 * if (net.state === 'joined') console.log(`player ${String(net.localPlayer)}, rtt ${String(net.rtt)} ms`);
 * ```
 */
export interface NetService {
  /** Where the page is in its room. */
  readonly state: NetState;
  /** The room's code, from the welcome (the code to show and share), or null before it or when the server does not say. */
  readonly room: string | null;
  /** Why the room closed, or `''` while it is open. A warning never sets it. */
  readonly closeReason: string;
  /**
   * The newest warning from the room (an `error` frame whose code does not end
   * the session, today `budget`: text frames were dropped, the seat is kept),
   * or `''` when none came. `stats.warnings` counts them.
   */
  readonly lastWarning: string;
  /** This page's player id, from the `welcome`; -1 before it. Seats start at 0. */
  readonly localPlayer: number;
  /** The entity this page's player controls (the frames' `entity`), or 0 for none. */
  readonly localEntity: number;
  /** Everyone in the room, held seats included, as the server last listed them. */
  readonly players: readonly PlayerSummary[];
  /** The last measured round trip to the server, in ms; 0 before the first `pong`. */
  readonly rtt: number;
  /**
   * The last input `seq` the authority applied for this player. It can go
   * backwards: a reconnected page restarts its sequence at 1.
   */
  readonly ack: number;
  /** The authority's tick, from the newest `cmd` or `welcome`. */
  readonly frame: number;
  /** How many `welcome`s have arrived. A change means "rebuild the world from the queue". */
  readonly welcomes: number;
  /** The room's seats, as the game declared them. */
  readonly maxPlayers: number;
  /** Rows frames per second the room sends (`features.multiplayer.sendHz`); the client blends across one interval. */
  readonly sendHz: number;
  /** Counters. */
  readonly stats: NetStats;
  /**
   * Join the room. The client loop calls it once it is attached, so a page
   * is seated only after its level, characters and sandbox have loaded.
   * Further calls do nothing.
   */
  start(): void;
  /**
   * Listen for changes to `state`, `room` and `closeReason`. The listener
   * runs as the frame that changed them arrives, so a page that draws no
   * frames (a hidden tab) still hears them.
   *
   * @param listener Called after a change.
   * @returns A function that removes the listener.
   */
  onChange(listener: () => void): () => void;
  /**
   * Send a game message up to the authority.
   *
   * @param name The message name.
   * @param payload Any JSON-serialisable value; at most 2,048 bytes of JSON.
   * @returns False when it was not sent (not joined, or the payload is too big).
   */
  send(name: string, payload: unknown): boolean;
  /**
   * Send a game message whose payload is already JSON text (a guest's `send` command).
   *
   * @param name The message name.
   * @param json The payload's JSON.
   * @returns False when it was not sent.
   */
  sendJson(name: string, json: string): boolean;
  /**
   * Send one step of input. Nothing is sent before the `welcome`, or while
   * reconnecting.
   *
   * @param seq This step's input sequence number.
   * @param snapshot The step's input.
   * @returns True when the frame went out.
   */
  sendInput(seq: number, snapshot: InputSnapshotLike): boolean;
  /** Send a `ping`; the `pong` updates `rtt`. */
  ping(): void;
  /**
   * Hand every queued authority command to `sink`, in arrival order, once.
   * After a `welcome` the queue starts with that welcome's world.
   */
  drainCommands(sink: (command: Command) => void): void;
  /** Decode every queued rows frame into `sink`, oldest first, dropping stale ones. */
  drainRows(sink: FramedRowSink): void;
  /** Hand every queued authority message to `sink`, in arrival order, once. */
  drainMessages(sink: NetMessageSink): void;
  /** Leave the room for good. */
  leave(reason?: string): void;
}
