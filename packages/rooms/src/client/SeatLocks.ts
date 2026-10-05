/**
 * `SeatLocks` — one lock per held seat, shared by every tab of the browser,
 * so a duplicated tab (which starts with a copy of the original's
 * `sessionStorage`, its token included) can tell that the seat is still in
 * use and joins as a new player instead of taking it.
 */

/**
 * A lock port: the Web Locks API (`navigator.locks`) in a browser, or a stand-in.
 *
 * @example
 * ```ts
 * import type { SeatLocks } from 'gameable/rooms/client';
 * const none: SeatLocks = { tryHold: () => Promise.resolve(() => undefined) };
 * ```
 */
export interface SeatLocks {
  /**
   * Take the lock `name` now if no one holds it.
   *
   * @returns A function that releases it, or null when another holder (another live tab) has it.
   */
  tryHold(name: string): Promise<(() => void) | null>;
}

/** The part of `LockManager` this needs. */
interface LockManagerLike {
  request(
    name: string,
    options: { ifAvailable: boolean },
    callback: (lock: unknown) => Promise<void> | undefined,
  ): Promise<unknown>;
}

/**
 * @returns The browser's Web Locks as a `SeatLocks`, or null where there are
 *   none (Node, an old browser, an insecure context). Without locks a
 *   duplicated tab is refused by the room server instead: it never takes a
 *   live player's seat, but it costs one failed lookup.
 *
 * @example
 * ```ts
 * import { webSeatLocks } from 'gameable/rooms/client';
 * const locks = webSeatLocks(); // null in Node
 * ```
 */
export function webSeatLocks(): SeatLocks | null {
  let manager: LockManagerLike | undefined;
  try {
    manager = (globalThis as { navigator?: { locks?: LockManagerLike } }).navigator?.locks;
  } catch {
    manager = undefined;
  }
  if (manager === undefined) return null;
  const locks = manager;
  return {
    tryHold: (name) =>
      new Promise((resolve, reject) => {
        locks
          .request(name, { ifAvailable: true }, (lock) => {
            if (lock === null) {
              resolve(null);
              return undefined;
            }
            // Held until released, or until this document goes (a reload frees it).
            return new Promise<void>((release) => {
              resolve(() => {
                release();
              });
            });
          })
          .catch(reject);
      }),
  };
}

/**
 * Locks inside one JS realm, for tests: every "tab" made with the same
 * instance shares them, as the tabs of one browser do.
 *
 * @example
 * ```ts
 * import { MemorySeatLocks } from 'gameable/rooms/client';
 * const locks = new MemorySeatLocks();
 * const release = await locks.tryHold('seat');
 * console.log(await locks.tryHold('seat')); // null: held
 * release?.();
 * ```
 */
export class MemorySeatLocks implements SeatLocks {
  /** The names held now. */
  readonly held = new Set<string>();

  tryHold(name: string): Promise<(() => void) | null> {
    if (this.held.has(name)) return Promise.resolve(null);
    this.held.add(name);
    let released = false;
    return Promise.resolve(() => {
      if (released) return;
      released = true;
      this.held.delete(name);
    });
  }
}
