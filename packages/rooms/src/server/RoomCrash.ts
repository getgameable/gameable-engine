/**
 * `RoomCrash` — how one room fails alone.
 */
import type { RoomReplication } from './RoomReplication.js';

/** What a crash needs from its room. */
export interface CrashableRoom {
  readonly roomId: string;
  readonly roomName: string;
  /** Colyseus's `disconnect()`: throws synchronously while the room is still being created. */
  disconnect(): Promise<unknown>;
}

/**
 * A room's crash state. `run(where, fn)` calls into the game and turns a throw
 * into a crash of this room alone: logged, every player told `error: ended` /
 * `crashed`, the room disconnected. After it the room never calls the game
 * again (`crashed`), and nothing it throws reaches Colyseus or the process.
 *
 * @example
 * ```ts
 * import { RoomCrash } from 'gameable/rooms/server';
 *
 * const crash = new RoomCrash(room, () => replication);
 * crash.run('onLeave', () => seating.leave(sessionId, code));
 * ```
 */
export class RoomCrash {
  /** True once the room crashed: the game is not called again. */
  crashed = false;

  /**
   * @param room The room.
   * @param replication Its outbound side, or null before it is built.
   */
  constructor(
    private readonly room: CrashableRoom,
    private readonly replication: () => RoomReplication | null,
  ) {}

  /**
   * @param where The hook, for the log.
   * @param fn A call into the game; skipped once crashed.
   * @returns True when `fn` ran and returned.
   */
  run(where: string, fn: () => void): boolean {
    return this.attempt(where, () => {
      fn();
      return true;
    }) === true;
  }

  /**
   * @param where The hook, for the log.
   * @param fn A call into the game; skipped once crashed.
   * @returns What `fn` returned, or undefined when it threw or the room had crashed.
   */
  attempt<T>(where: string, fn: () => T): T | undefined {
    if (this.crashed) return undefined;
    try {
      return fn();
    } catch (error) {
      this.crash(error, where);
      return undefined;
    }
  }

  /**
   * Close the room because its game threw. Later throws while it closes are
   * logged only.
   *
   * @param error What was thrown.
   * @param where Where.
   */
  crash(error: unknown, where: string): void {
    const { roomId, roomName } = this.room;
    console.error(`[rooms] room ${roomId} (${roomName}) threw in ${where}`, error);
    if (this.crashed) return;
    this.crashed = true;
    try {
      const replication = this.replication();
      replication?.sendAll(replication.wire.error('ended', 'crashed'));
    } catch (sendError) {
      console.error(`[rooms] room ${roomId}: telling its players failed`, sendError);
    }
    try {
      this.room.disconnect().catch((closeError: unknown) => {
        console.error(`[rooms] room ${roomId}: disconnect failed`, closeError);
      });
    } catch (closeError) {
      console.error(`[rooms] room ${roomId}: disconnect threw`, closeError);
    }
  }
}
