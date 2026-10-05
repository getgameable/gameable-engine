/**
 * `DocSlot` — one stored document as a room holds it: the version the store
 * last answered, and the newest save not yet written, behind a throttle.
 */

/** What a slot asks of its room: run work in the key's order, and write. */
export interface SlotPorts {
  /** Run `work` after everything already queued for this key; never rejects. */
  queue(key: string, work: () => Promise<void>): Promise<void>;
  /** Write `doc` at `slot.version`; updates `slot.version` on success. Never rejects. */
  write(slot: DocSlot, doc: string): Promise<void>;
  /** Ms between two writes of one document. */
  readonly throttleMs: number;
}

/**
 * One document's save throttle: at most one write per `throttleMs`, the
 * newest save wins, and a `flush` writes what is pending now.
 *
 * @example
 * ```ts
 * const slot = new DocSlot('u1', ports);
 * slot.save('{"coins":1}'); // written now
 * slot.save('{"coins":2}'); // written 6 s after the first, unless flushed sooner
 * await slot.flush();
 * ```
 */
export class DocSlot {
  /** The stored version this room last saw; 0 for no document. */
  version = 0;
  private latest: string | null = null;
  private lastWrite = Number.NEGATIVE_INFINITY;
  private timer: ReturnType<typeof setTimeout> | null = null;

  /**
   * @param key The store key (a player id, or the game's).
   * @param ports The room's queue and writer.
   */
  constructor(
    readonly key: string,
    private readonly ports: SlotPorts,
  ) {}

  /** @param doc The newest document, as JSON: written now, or when the throttle allows. */
  save(doc: string): void {
    this.latest = doc;
    if (this.timer !== null) return;
    const wait = this.lastWrite + this.ports.throttleMs - Date.now();
    if (wait <= 0) {
      void this.flush();
      return;
    }
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, wait);
    (this.timer as { unref?: () => void }).unref?.();
  }

  /**
   * Write the pending document, in this key's order.
   *
   * @returns Settles once it is written (or refused, logged); never rejects.
   */
  flush(): Promise<void> {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    if (this.latest !== null) this.lastWrite = Date.now();
    return this.ports.queue(this.key, async () => {
      // Read when the queue reaches it: a save dropped meanwhile is not written.
      const doc = this.latest;
      this.latest = null;
      if (doc !== null) await this.ports.write(this, doc);
    });
  }

  /** Forget the pending save: an exchange made it stale. */
  drop(): void {
    this.latest = null;
  }
}
