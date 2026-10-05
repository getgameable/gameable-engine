/**
 * `LinkWatch` — what a joined client does about a link that is not working:
 * the resync an overflowing queue asked for, once, and a reconnect after
 * `silenceMs` of fixed steps with no server frame. The room sends a `cmd`
 * every tick, so silence means a dead link the browser has not noticed (a
 * Wi-Fi change leaves a half-open socket `OPEN` for minutes).
 *
 * It counts steps, not wall-clock time: a hidden tab runs none, so a tab
 * coming back is not taken for a dead link.
 */

/** What the watch asks the connection for, if anything. */
export type LinkAction = 'resync' | 'silent' | null;

/** Silence and resync bookkeeping. Owned by `NetClient`. */
export class LinkWatch {
  private quietMs = 0;
  private resyncAsked = false;

  /** @param silenceMs Milliseconds of steps with no frame that mean a dead link. */
  constructor(private readonly silenceMs: number) {}

  /** A server frame arrived. */
  heard(): void {
    this.quietMs = 0;
  }

  /** A welcome arrived: a resync may be asked for again. */
  welcomed(): void {
    this.quietMs = 0;
    this.resyncAsked = false;
  }

  /**
   * @param dtMs The fixed step, in ms.
   * @param joined The client is joined.
   * @param overflowed The queues overflowed and wait for a fresh welcome.
   * @returns What to ask the connection for this step.
   */
  step(dtMs: number, joined: boolean, overflowed: boolean): LinkAction {
    if (!joined) {
      this.quietMs = 0;
      return null;
    }
    if (overflowed) {
      if (this.resyncAsked) return null;
      this.resyncAsked = true;
      return 'resync';
    }
    this.quietMs += dtMs;
    if (this.quietMs < this.silenceMs) return null;
    this.quietMs = 0;
    return 'silent';
  }
}
