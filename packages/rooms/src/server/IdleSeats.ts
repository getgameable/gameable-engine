/**
 * `IdleSeats` — finds connected clients that have sent no frame for a while.
 */
import type { SeatMap } from './SeatMap.js';

/** How often the seats are looked at, ms: the drop is never more than this late. */
const SWEEP_EVERY_MS = 250;

/**
 * Once every 250 ms, every connected seat whose client has sent no frame
 * (`Seat.lastFrameAt`) for `afterMs` is handed to `drop`. The room drops that
 * client with `IDLE_CLOSE_CODE`, and the seat is held as after any drop, so
 * an idle socket cannot keep a seat forever. Nothing allocates.
 *
 * @example
 * ```ts
 * import { IdleSeats } from 'gameable/rooms/server';
 *
 * const idle = new IdleSeats(120_000, (sessionId) => room.clients.get(sessionId)?.leave(4100));
 * idle.sweep(seats, performance.now()); // each tick
 * ```
 */
export class IdleSeats {
  private nextSweep = 0;

  /**
   * @param afterMs How long without a frame.
   * @param drop Drops one client.
   */
  constructor(
    private readonly afterMs: number,
    private readonly drop: (sessionId: string) => void,
  ) {}

  /**
   * @param seats The room's seats.
   * @param now `performance.now()`, ms.
   */
  sweep(seats: SeatMap, now: number): void {
    if (now < this.nextSweep) return;
    this.nextSweep = now + SWEEP_EVERY_MS;
    const list = seats.list();
    for (let i = 0; i < list.length; i += 1) {
      const seat = list[i];
      if (!seat.player.connected || seat.dropped !== null || now - seat.lastFrameAt < this.afterMs) continue;
      seat.lastFrameAt = now; // dropped once: the close lands later
      this.drop(seat.sessionId);
    }
  }
}
