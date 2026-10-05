/**
 * `WarnOnce` — a warning sink that says each thing once.
 *
 * Several warnings sit on the per-tick path (a pointer lock every step, a
 * crouch the physics module cannot do), so they are keyed on a short constant
 * and the message is only built the first time.
 */
import type { WarnSink } from './types';

/**
 * Deduplicating front for a {@link WarnSink}.
 *
 * @example
 * ```ts
 * // Internal to the server adapter:
 * const warnings = new WarnOnce(console.warn);
 * warnings.warn('no-audio');
 * warnings.warn('no-audio'); // silent
 * ```
 */
export class WarnOnce {
  private readonly seen = new Set<string>();
  private readonly sink: WarnSink;

  /** @param sink Where the first occurrence of each warning goes. */
  constructor(sink: WarnSink) {
    this.sink = sink;
  }

  /**
   * Warn once per key.
   *
   * @param key What is being warned about. Deduplicated on this, never on the text.
   * @param build Builds the message; omit it when `key` is the message.
   */
  warn(key: string, build?: () => string): void {
    if (this.seen.has(key)) return;
    this.seen.add(key);
    this.sink(build === undefined ? key : build());
  }
}
