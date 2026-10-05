/**
 * `RoomClock` — a room's fixed-rate tick on `ports.setTimer`.
 */
import type { RoomPorts } from './RoomPorts.js';

/**
 * Calls `tick` every `everyMs`, each timer aimed at its due time so the rate
 * does not drift; a late timer is caught up by firing the next one at once.
 *
 * @example
 * ```ts
 * import { RoomClock } from 'gameable/net/server';
 *
 * const clock = new RoomClock(ports, 1000 / 60, () => room.tick());
 * clock.stop();
 * ```
 */
export class RoomClock {
  private timer: unknown = null;
  private nextAt: number;
  private stopped = false;

  /**
   * Starts at once: the first tick is due `everyMs` from now.
   *
   * @param ports The room's ports.
   * @param everyMs Milliseconds between ticks.
   * @param tick What to call.
   */
  constructor(
    private readonly ports: RoomPorts,
    private readonly everyMs: number,
    private readonly tick: () => void,
  ) {
    this.nextAt = ports.now() + everyMs;
    this.arm();
  }

  /** Stop for good; a pending timer is cancelled. */
  stop(): void {
    this.stopped = true;
    if (this.timer !== null) this.ports.clearTimer(this.timer);
    this.timer = null;
  }

  /** Schedule the next tick. */
  private arm(): void {
    if (this.stopped) return;
    const delay = Math.max(0, this.nextAt - this.ports.now());
    this.timer = this.ports.setTimer(this.fire, delay);
  }

  private readonly fire = (): void => {
    this.timer = null;
    if (this.stopped) return;
    this.nextAt += this.everyMs;
    this.tick();
    this.arm();
  };
}
