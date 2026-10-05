/**
 * `LatencyTransport` — a transport that delays every frame and drops binary ones.
 *
 * It wraps one end of a loopback pair. Tests use it to see the netcode under a
 * slow, lossy link without a network. The loss draws from a seeded generator,
 * so a run is the same every time.
 */
import { loopbackPair } from './LoopbackTransport.js';
import { BaseTransport, type Transport, type TransportData } from './Transport.js';

/** What the simulated link does to a frame. */
export interface LatencyOptions {
  /** Milliseconds each frame is held before it is sent on. Default 0. */
  ms?: number;
  /** Chance from 0 to 1 that a binary frame is dropped. Text frames are never dropped. Default 0. */
  loss?: number;
  /** Seed of the loss generator, so a test drops the same frames each run. Default 1. */
  seed?: number;
}

/** A small seeded generator (mulberry32): the same seed gives the same sequence. */
function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** One end of a latency pair: sends are delayed and may drop; receives pass straight through. */
export class LatencyTransport extends BaseTransport {
  private pending = 0;

  constructor(
    private readonly inner: Transport,
    private readonly ms: number,
    private readonly loss: number,
    private readonly random: () => number,
  ) {
    super();
    inner.onMessage((data) => {
      this.deliver(data);
    });
    inner.onClose((reason) => {
      this.finish(reason);
    });
  }

  /** Bytes sent and still waiting out their delay. */
  get bufferedAmount(): number {
    return this.pending + this.inner.bufferedAmount;
  }

  send(data: TransportData): void {
    if (this.isClosed) return;
    if (typeof data !== 'string' && this.loss > 0 && this.random() < this.loss) return;
    // A real socket takes its bytes at send time, and callers reuse scratch buffers.
    const frame = typeof data === 'string' ? data : data.slice();
    const bytes = typeof frame === 'string' ? frame.length : frame.byteLength;
    this.pending += bytes;
    this.later(() => {
      this.pending -= bytes;
      this.inner.send(frame);
    });
  }

  protected shutdown(reason: string): void {
    // The close waits its turn behind the frames already in flight, as a real one would.
    this.later(() => {
      this.inner.close(reason);
    });
  }

  private later(run: () => void): void {
    setTimeout(run, this.ms);
  }
}

/**
 * Two transports with a simulated link between them: each frame waits `ms`,
 * and each binary frame is dropped with probability `loss`. Text frames are
 * the reliable channel and are never dropped.
 *
 * @example
 * ```ts
 * import { latencyPair } from 'gameable/net/testing';
 * const [client, server] = latencyPair({ ms: 50, loss: 0.1, seed: 7 });
 * server.onMessage((data) => console.log('after 50 ms:', data));
 * client.send('{"t":"ping","n":1}');
 * ```
 */
export function latencyPair(options: LatencyOptions = {}): [Transport, Transport] {
  const { ms = 0, loss = 0, seed = 1 } = options;
  const [a, b] = loopbackPair();
  return [
    new LatencyTransport(a, ms, loss, seededRandom(seed)),
    new LatencyTransport(b, ms, loss, seededRandom(seed + 1)),
  ];
}
