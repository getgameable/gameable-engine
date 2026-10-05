/**
 * `PageAway` — calls back the moment the page stops being played: the tab
 * is hidden, the window loses focus, or the page is being unloaded. A hidden
 * tab runs no fixed steps, so this is the only moment its input can still go
 * out (the `net` module sends a neutral one).
 */

/** The slice of an event target this listens on. */
export interface AwayTarget {
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
}

/** Where the page's away events come from; both default to the browser's own. */
export interface AwaySources {
  /** `blur` and `pagehide`. Default `globalThis.window`, absent outside a browser. */
  readonly window?: AwayTarget | null;
  /** `visibilitychange` to hidden. Default `globalThis.document`, absent outside a browser. */
  readonly document?: (AwayTarget & { readonly visibilityState: string }) | null;
}

/** The away listeners. `dispose()` removes them. */
export class PageAway {
  private readonly window: AwayTarget | null;
  private readonly document: (AwayTarget & { readonly visibilityState: string }) | null;

  /**
   * @param away Called on each away event.
   * @param sources The window and document to listen on.
   */
  constructor(
    private readonly away: () => void,
    sources: AwaySources = {},
  ) {
    const global = globalThis as { window?: AwayTarget; document?: AwaySources['document'] };
    this.window = sources.window === undefined ? (global.window ?? null) : sources.window;
    this.document = sources.document === undefined ? (global.document ?? null) : sources.document;
    this.window?.addEventListener('blur', this.away);
    this.window?.addEventListener('pagehide', this.away);
    this.document?.addEventListener('visibilitychange', this.onVisibility);
  }

  dispose(): void {
    this.window?.removeEventListener('blur', this.away);
    this.window?.removeEventListener('pagehide', this.away);
    this.document?.removeEventListener('visibilitychange', this.onVisibility);
  }

  private readonly onVisibility = (): void => {
    if (this.document?.visibilityState === 'hidden') this.away();
  };
}
