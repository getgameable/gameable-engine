/**
 * `SoloPorts` — the `RoomPorts` of a room in the page: the page-stepped
 * clock, and one loopback transport per connection.
 */
import type { Room } from '../server/room/Room.js';
import type { RoomPorts } from '../server/room/RoomPorts.js';
import { loopbackPair } from '../transport/LoopbackTransport.js';
import type { Transport } from '../transport/Transport.js';
import { PageClock } from './PageClock.js';

/**
 * A room's outside world when the room runs in the page: time from
 * {@link PageClock}, and each connection a {@link loopbackPair} whose server
 * end feeds `room.handle` and `room.disconnect`.
 *
 * @example
 * ```ts
 * import { createRoom } from 'gameable/net/server';
 * import { SoloPorts } from 'gameable/net/solo';
 *
 * const ports = new SoloPorts();
 * const room = createRoom({ code: 'SOLO', game, ports, sendHz: 20 });
 * const clientEnd = ports.open(room); // a LoopbackConnection's `connect`
 * ```
 */
export class SoloPorts extends PageClock implements RoomPorts {
  private readonly ends = new Map<string, Transport>();
  private next = 0;

  /** @param logSink Where the room's log lines go. Default: dropped. */
  constructor(
    private readonly logSink: (event: string, detail?: object) => void = () => undefined,
  ) {
    super();
  }

  /** @returns A uniform random number in `[0, 1)`: the seat secret of a room nobody else can reach. */
  random(): number {
    return Math.random();
  }

  /**
   * @param conn The connection.
   * @param data A frame; the loopback transport copies binary frames on send.
   */
  send(conn: string, data: string | Uint8Array): void {
    this.ends.get(conn)?.send(data);
  }

  /**
   * @param conn The connection the room has dropped.
   * @param reason Why.
   */
  drop(conn: string, reason: string): void {
    const end = this.ends.get(conn);
    this.ends.delete(conn);
    end?.close(reason);
  }

  /**
   * @param event The log line's name.
   * @param detail Its ids and reasons.
   */
  log(event: string, detail?: object): void {
    this.logSink(event, detail);
  }

  /**
   * Open one connection to the room: a fresh loopback pair whose server end
   * the room reads.
   *
   * @param room The room.
   * @returns The client end.
   */
  open(room: Room): Transport {
    const [client, server] = loopbackPair();
    this.next += 1;
    const conn = `solo-${String(this.next)}`;
    this.ends.set(conn, server);
    server.onMessage((data) => {
      room.handle(conn, data);
    });
    server.onClose(() => {
      this.ends.delete(conn);
      room.disconnect(conn);
    });
    return client;
  }
}
