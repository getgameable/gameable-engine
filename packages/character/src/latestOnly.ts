// Run an async task one at a time; a burst collapses to one re-run at the newest arguments.
//
// Ported from aos-threejs-poc/src/lib/latestOnly.js @ cdd63b10

/** A coalescing wrapper: `isRunning()` reports whether a task is in flight. */
export type LatestOnly<A extends unknown[]> = ((...args: A) => Promise<void>) & {
  isRunning: () => boolean;
  /**
   * Resolves when the in-flight run — INCLUDING every replay it coalesced — has
   * drained, or immediately when nothing is running.
   *
   * `run()` resolves as soon as a call is either started or parked as the pending
   * newest arguments, so awaiting IT tells a caller nothing about the work. Waiting
   * for the drain used to mean spinning on `isRunning()` and awaiting a promise that
   * was already resolved, which burns a microtask per turn for as long as the pass
   * takes; this is one await.
   */
  whenIdle: () => Promise<void>;
};

/**
 * Wrap `task` so overlapping calls coalesce: while one run is in flight the
 * newest arguments are remembered and replayed once it finishes, and everything
 * in between is dropped. The appearance pass is a decode plus a lift, so a burst
 * of camera moves must cost one extra pass at the newest view, not one per move.
 *
 * @param task The async work to coalesce; it is never run concurrently with itself.
 * @returns A callable with the same arguments as `task`, which resolves as soon as
 * the call is either started or parked as the pending newest arguments, plus an
 * `isRunning()` probe for whether a run is currently in flight and a `whenIdle()`
 * promise that resolves once the in-flight run and all of its replays have drained.
 */
export function latestOnly<A extends unknown[]>(
  task: (...args: A) => Promise<void>,
): LatestOnly<A> {
  let running = false;
  let pendingArguments: A | null = null;
  // The in-flight run's drain, handed out by `whenIdle()`. One promise for the WHOLE
  // loop below, replays included, so a waiter cannot return between a run and the
  // replay it queued.
  let idle: Promise<void> | null = null;
  let settleIdle: (() => void) | null = null;

  const run = async (...taskArguments: A): Promise<void> => {
    if (running) {
      pendingArguments = taskArguments;
      return;
    }
    running = true;
    idle = new Promise<void>((resolve) => {
      settleIdle = resolve;
    });
    let current = taskArguments;
    try {
      for (;;) {
        await task(...current);
        if (!pendingArguments) return;
        current = pendingArguments;
        pendingArguments = null;
      }
    } finally {
      running = false;
      pendingArguments = null;
      const settle = settleIdle;
      idle = null;
      settleIdle = null;
      settle?.();
    }
  };

  const wrapped = run as LatestOnly<A>;
  wrapped.isRunning = () => running;
  wrapped.whenIdle = () => idle ?? Promise.resolve();
  return wrapped;
}
