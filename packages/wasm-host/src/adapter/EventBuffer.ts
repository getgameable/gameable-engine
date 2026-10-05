/**
 * The host event queue, double-buffered, shared by the page loop and the server loop.
 */
import type { GameEvent } from '@gameable/sdk';

/**
 * Hands each tick the events queued since the last one, without allocating.
 *
 * The adapter's `events` array is the queue producers push onto, and it keeps
 * its identity for the life of the adapter; this is the array the guest is
 * handed, refilled in place each tick, so a frame with events allocates
 * nothing.
 *
 * @example
 * ```ts
 * import type { GameEvent } from 'gameable';
 * import { EventBuffer } from './adapter/EventBuffer';
 *
 * const queued: GameEvent[] = [];
 * const buffer = new EventBuffer();
 * console.log(buffer.drain(queued)); // undefined: nothing was queued
 * ```
 */
export class EventBuffer {
  /** The array the guest reads; never reallocated. */
  private readonly frame: GameEvent[] = [];

  /**
   * Move everything queued into the frame buffer and empty the queue.
   *
   * @param queued The producers' queue; emptied in place.
   * @returns This tick's events, or `undefined` when none were queued. The
   *   array is reused by the next call; do not retain it.
   */
  drain(queued: GameEvent[]): readonly GameEvent[] | undefined {
    if (queued.length === 0) return undefined;
    const frame = this.frame;
    frame.length = 0;
    for (let i = 0; i < queued.length; i += 1) frame.push(queued[i]);
    queued.length = 0;
    return frame;
  }
}
