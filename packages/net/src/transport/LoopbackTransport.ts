/**
 * `LoopbackTransport` — two in-memory ends wired to each other.
 *
 * Delivery goes through `queueMicrotask`, so a `send` made inside a message
 * handler never re-enters a handler synchronously, and frames arrive in the
 * order they were sent.
 */
import { BaseTransport, type Transport, type TransportData } from './Transport.js';

/** One end of a loopback pair. */
export class LoopbackTransport extends BaseTransport {
  readonly bufferedAmount = 0;
  private peer: LoopbackTransport | null = null;

  /** Wires two ends to each other. */
  static pair(): [LoopbackTransport, LoopbackTransport] {
    const a = new LoopbackTransport();
    const b = new LoopbackTransport();
    a.peer = b;
    b.peer = a;
    return [a, b];
  }

  send(data: TransportData): void {
    const peer = this.peer;
    if (this.isClosed || peer === null) return;
    // A real socket takes its bytes at send time, and callers reuse scratch buffers.
    const frame = typeof data === 'string' ? data : data.slice();
    queueMicrotask(() => {
      peer.deliver(frame);
    });
  }

  protected shutdown(reason: string): void {
    const peer = this.peer;
    this.peer = null;
    // Queued behind every frame already sent, so the far end reads them before the close.
    if (peer !== null) {
      queueMicrotask(() => {
        peer.finish(reason);
      });
    }
  }
}

/**
 * Two transports wired to each other in memory: what one sends, the other
 * receives, in order, one microtask later. Closing either end closes both,
 * with the same reason.
 *
 * @example
 * ```ts
 * import { loopbackPair } from 'gameable/net/testing';
 * const [a, b] = loopbackPair();
 * b.onMessage((data) => console.log('b got', data));
 * b.onClose((reason) => console.log('b closed:', reason));
 * a.send('hi');
 * a.close('done');
 * ```
 */
export function loopbackPair(): [Transport, Transport] {
  return LoopbackTransport.pair();
}
