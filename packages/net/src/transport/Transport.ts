/**
 * `Transport` — the one-socket-shaped pipe the multiplayer code talks through.
 *
 * Rooms and clients never touch a WebSocket directly. They hold a `Transport`,
 * so the same code runs over a browser socket, a Node socket, an in-memory
 * pair in a test, or a pair with simulated latency and loss.
 */

/** One frame: JSON text, or the bytes of a binary frame. */
export type TransportData = string | Uint8Array;

/**
 * A two-way pipe of frames. Text frames are the reliable channel; binary
 * frames (inputs, rows) may be dropped on a lossy link.
 *
 * @example
 * ```ts
 * import type { Transport } from 'gameable/net';
 * import { loopbackPair } from 'gameable/net/testing';
 * const [client, server]: [Transport, Transport] = loopbackPair();
 * server.onMessage((data) => console.log(data));
 * client.send('{"t":"ping","n":1}');
 * ```
 */
export interface Transport {
  /** Sends one frame. After the transport is closed this does nothing. */
  send(data: TransportData): void;
  /** Registers a listener for every frame received. Registering after close does nothing. */
  onMessage(cb: (data: TransportData) => void): void;
  /** Registers a listener for the close, called once with the reason. Registering after close does nothing. */
  onClose(cb: (reason: string) => void): void;
  /** Closes the transport. Safe to call twice; the close listeners fire once. */
  close(reason?: string): void;
  /** Bytes queued to send and not yet written out; a sender can skip a binary frame while this is high. */
  readonly bufferedAmount: number;
}

/**
 * The base every transport extends: the listener lists and the closed latch.
 *
 * A subclass feeds frames in with `deliver`, reports the far side going away
 * with `finish`, and says how to tear down its own pipe in `shutdown`.
 *
 * @example
 * ```ts
 * import { BaseTransport } from 'gameable/net';
 * class Echo extends BaseTransport {
 *   readonly bufferedAmount = 0;
 *   send(data: string | Uint8Array): void {
 *     if (!this.isClosed) this.deliver(data);
 *   }
 *   protected shutdown(): void {}
 * }
 * const echo = new Echo();
 * echo.onMessage((data) => console.log(data));
 * echo.send('hello');
 * ```
 */
export abstract class BaseTransport implements Transport {
  private readonly messageListeners: ((data: TransportData) => void)[] = [];
  private readonly closeListeners: ((reason: string) => void)[] = [];
  private closed = false;

  abstract readonly bufferedAmount: number;

  abstract send(data: TransportData): void;

  /** Tears down the underlying pipe; called once, by the first `close`. */
  protected abstract shutdown(reason: string): void;

  /** Whether the transport has closed, from either end. */
  protected get isClosed(): boolean {
    return this.closed;
  }

  onMessage(cb: (data: TransportData) => void): void {
    if (!this.closed) this.messageListeners.push(cb);
  }

  onClose(cb: (reason: string) => void): void {
    if (!this.closed) this.closeListeners.push(cb);
  }

  close(reason = 'closed'): void {
    if (this.closed) return;
    this.shutdown(reason);
    this.finish(reason);
  }

  /** Hands one received frame to every message listener; nothing after close. */
  protected deliver(data: TransportData): void {
    if (this.closed) return;
    for (const cb of this.messageListeners) {
      try {
        cb(data);
      } catch (error) {
        console.error('transport message listener threw', error);
      }
    }
  }

  /** Latches closed and fires the close listeners, once however often it is called. */
  protected finish(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    const listeners = this.closeListeners.splice(0);
    this.messageListeners.length = 0;
    for (const cb of listeners) {
      try {
        cb(reason);
      } catch (error) {
        console.error('transport close listener threw', error);
      }
    }
  }
}
