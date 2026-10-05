/**
 * What a room needs from the process it runs in, and how it is configured.
 * The room itself touches no socket, timer or clock directly, so a test runs
 * it with a hand-stepped clock and a browser test can run it in a page.
 */
import type { TextLimitOptions } from '../inbound/TextLimit.js';
import type { RoomGame } from './RoomGame.js';

/**
 * The room's outside world.
 *
 * `send` is handed **borrowed** bytes: a rows frame is written into the
 * room's one reused send buffer, so the bytes are good only during the call.
 * A port that keeps them past the call must copy them first.
 *
 * @example
 * ```ts
 * import type { RoomPorts } from 'gameable/net/server';
 *
 * const sockets = new Map<string, { send(data: string | Uint8Array): void; close(): void }>();
 * const ports: RoomPorts = {
 *   now: () => performance.now(),
 *   setTimer: (fn, ms) => setTimeout(fn, ms),
 *   clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
 *   random: () => Math.random(),
 *   send: (conn, data) => sockets.get(conn)?.send(typeof data === 'string' ? data : data.slice()),
 *   drop: (conn) => sockets.get(conn)?.close(),
 *   log: (event, detail) => console.log(event, detail),
 * };
 * ```
 */
export interface RoomPorts {
  /** @returns A monotonic clock in milliseconds. */
  now(): number;
  /**
   * Call `fn` once after `ms` milliseconds.
   *
   * @param fn What to call.
   * @param ms The delay; may be 0.
   * @returns A handle for {@link RoomPorts.clearTimer}.
   */
  setTimer(fn: () => void, ms: number): unknown;
  /**
   * Cancel a pending timer.
   *
   * @param handle A handle `setTimer` returned.
   */
  clearTimer(handle: unknown): void;
  /** @returns A uniform random number in `[0, 1)`; seat secrets are made from it. */
  random(): number;
  /**
   * Send one frame to one connection. Bytes are borrowed: copy to keep.
   *
   * @param conn The connection id the host gave `handle`.
   * @param data A text frame, or a binary frame good only during the call.
   */
  send(conn: string, data: string | Uint8Array): void;
  /**
   * Close one connection. The room has already forgotten it.
   *
   * @param conn The connection id.
   * @param reason Why, in a word: `full`, `room`, `seat`, `version`, `ended`, `replaced`, `budget`.
   */
  drop(conn: string, reason: string): void;
  /**
   * One line of the room's log.
   *
   * @param event What happened, as a short dotted name (`room.join`).
   * @param detail Ids and reasons; never a secret.
   */
  log(event: string, detail?: object): void;
  /**
   * Compare two seat secrets. Optional: plain `===` when absent. A server
   * passes a constant-time compare (Task 3.7).
   *
   * @param a The secret the seat holds.
   * @param b The secret the client sent.
   * @returns True when they are the same.
   */
  equalSecrets?(a: string, b: string): boolean;
}

/**
 * What `createRoom` takes.
 *
 * @example
 * ```ts
 * import type { RoomOptions } from 'gameable/net/server';
 *
 * const options: Omit<RoomOptions, 'game' | 'ports'> = { code: 'KQTX', maxPlayers: 8, sendHz: 20 };
 * ```
 */
export interface RoomOptions {
  /** The room's code, as the host lists it. */
  code: string;
  /** The game the room drives. The room disposes it on `close`. */
  game: RoomGame;
  /** The outside world. */
  ports: RoomPorts;
  /**
   * Seats, held ones included. Leave it out when the game knows its own
   * (`RoomGame.maxPlayers`, as `EngineRoomGame` does); a value that
   * disagrees with the game's throws.
   */
  maxPlayers?: number;
  /** Rows frames per second to each player. Commands go every tick regardless. */
  sendHz: number;
  /** Room ticks per second. Default 60, the simulation rate. */
  tickHz?: number;
  /** How long a disconnected seat is held before `leave(player, 'timeout')`. Default 600,000 (10 min). */
  leaveAfterMs?: number;
  /**
   * Each seat's text-frame limit (`msg`, `ping`). Default 40, +20 per 5 s;
   * out of budget the player is told `error: budget` once and the frames
   * are dropped; 100 refusals in a row free the seat (`leave(player, 'budget')`).
   */
  text?: TextLimitOptions;
}
