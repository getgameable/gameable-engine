/**
 * `TokenBuckets` — one token bucket per key (a client address).
 */

/**
 * A bucket's shape: `burst` tokens when full, one more every `refillMs`.
 *
 * @example
 * ```ts
 * import type { BucketOptions } from 'gameable/rooms/server';
 *
 * const misses: BucketOptions = { burst: 10, refillMs: 2000 }; // 10 at once, then 1 per 2 s
 * ```
 */
export interface BucketOptions {
  readonly burst: number;
  readonly refillMs: number;
}

interface Bucket {
  tokens: number;
  at: number;
}

/** Least time between two sweeps of refilled buckets. */
const SWEEP_EVERY_MS = 5000;
/** The most keys held at once; past it every new key shares one bucket. */
const MAX_KEYS = 50_000;
/** The key every new client shares while the map is full: a full map fails closed. */
export const OVERFLOW_KEY = '*overflow*';

/**
 * Token buckets by key. A key never seen has a full bucket. Refilled buckets
 * are swept out at most once every 5 s, as one pass, never as a scan per new
 * key; and the map never holds more than `maxKeys` keys: while it is full, every
 * new key spends from one shared bucket (`OVERFLOW_KEY`), so a flood of new
 * addresses buys one budget between them, not one each.
 *
 * @example
 * ```ts
 * import { TokenBuckets } from 'gameable/rooms/server';
 *
 * const creates = new TokenBuckets({ burst: 4, refillMs: 15_000 });
 * if (!creates.take('203.0.113.7')) console.log('429');
 * ```
 */
export class TokenBuckets {
  private readonly buckets = new Map<string, Bucket>();
  private sweptAt: number;

  /**
   * @param options Burst and refill.
   * @param now The clock in ms; `performance.now` by default.
   * @param maxKeys The most keys held at once (default 50,000).
   */
  constructor(
    readonly options: BucketOptions,
    private readonly now: () => number = () => performance.now(),
    private readonly maxKeys = MAX_KEYS,
  ) {
    if (!(options.burst >= 1) || !(options.refillMs > 0))
      throw new Error('TokenBuckets: burst must be at least 1 and refillMs above 0');
    this.sweptAt = now();
  }

  /** @returns Keys held. */
  get size(): number {
    return this.buckets.size;
  }

  /**
   * @param key The client.
   * @returns True when the key has a token left (nothing is spent).
   */
  has(key: string): boolean {
    return this.level(this.keyFor(key)).tokens >= 1;
  }

  /**
   * @param key The client.
   * @returns True when a token was spent; false when the bucket is empty.
   */
  take(key: string): boolean {
    const now = this.now();
    if (now - this.sweptAt >= SWEEP_EVERY_MS) this.sweep(now);
    const held = this.keyFor(key);
    const bucket = this.level(held);
    if (bucket.tokens < 1) return false;
    bucket.tokens -= 1;
    if (!this.buckets.has(held)) this.buckets.set(held, bucket);
    return true;
  }

  /**
   * @param key The client.
   * @returns The key its tokens come from: its own, or the shared one while the map is full.
   */
  private keyFor(key: string): string {
    return this.buckets.has(key) || this.buckets.size < this.maxKeys ? key : OVERFLOW_KEY;
  }

  /**
   * @param key A held key.
   * @returns Its bucket, refilled to now (a fresh full one for a new key).
   */
  private level(key: string): Bucket {
    const now = this.now();
    const bucket = this.buckets.get(key);
    if (bucket === undefined) return { tokens: this.options.burst, at: now };
    const refilled = (now - bucket.at) / this.options.refillMs;
    bucket.tokens = Math.min(this.options.burst, bucket.tokens + refilled);
    bucket.at = now;
    return bucket;
  }

  /** @param now The clock: forget every bucket that has refilled to full. */
  private sweep(now: number): void {
    this.sweptAt = now;
    const { burst, refillMs } = this.options;
    for (const [key, bucket] of this.buckets)
      if (bucket.tokens + (now - bucket.at) / refillMs >= burst) this.buckets.delete(key);
  }
}
