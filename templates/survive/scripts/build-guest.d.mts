/** Types for `build-guest.mjs`, for `vite.config.ts` and the tests. */

/** Whether the built guest is older than its sources; mtimes in ms, 0 when absent. */
export function guestFreshness(paths?: { guestEntry?: string; sources?: string[] }): {
  builtAt: number;
  sourceAt: number;
  stale: boolean;
};

/** Build the guest when it is stale (or always, with `force`). */
export function buildGuest(options?: { force?: boolean; quiet?: boolean }): {
  built: boolean;
  guestEntry: string;
  guestDir: string;
};

export const ROOT: string;
export const BUILD: string;
export const GUEST_DIR: string;
export const GUEST_ENTRY: string;
