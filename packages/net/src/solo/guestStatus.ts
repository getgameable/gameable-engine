/**
 * Play Solo's stale-guest check. Its authority runs the game built to wasm
 * (`build/guest/`), even under `npm run dev`, while the page's own client
 * guest runs the TypeScript as it is now. When the build is older than the
 * sources the two run different rules, silently, so a dev page asks the dev
 * server (`gameable/vite` answers) and warns.
 */

/**
 * Where the dev server answers whether the built guest is stale. The same
 * path is `GUEST_STATUS_PATH` in `gameable/vite`, which serves it.
 *
 * @example
 * ```ts
 * import { GUEST_STATUS_PATH } from 'gameable/net/solo';
 *
 * console.log(GUEST_STATUS_PATH); // '/__aos/guest-status.json'
 * ```
 */
export const GUEST_STATUS_PATH = '/__aos/guest-status.json';

/**
 * The dev server's answer at {@link GUEST_STATUS_PATH}.
 *
 * @example
 * ```ts
 * import type { GuestStatus } from 'gameable/net/solo';
 *
 * const status: GuestStatus = { builtAt: 0, sourceAt: 1, stale: true };
 * ```
 */
export interface GuestStatus {
  /** The built guest's mtime in ms, or 0 when there is none. */
  builtAt: number;
  /** The newest mtime among the sources it is built from. */
  sourceAt: number;
  /** No guest, or a source newer than it. */
  stale: boolean;
}

/**
 * The slice of `fetch` the check uses.
 *
 * @example
 * ```ts
 * import type { GuestStatusFetch } from 'gameable/net/solo';
 *
 * const ask: GuestStatusFetch = (path) => fetch(path, { cache: 'no-store' });
 * ```
 */
export type GuestStatusFetch = (path: string) => Promise<{ ok: boolean; json(): Promise<unknown> }>;

/**
 * The warning a stale dev guest earns.
 *
 * @param status The dev server's answer.
 * @returns The warning, or null when the guest is up to date.
 *
 * @example
 * ```ts
 * import { staleGuestWarning } from 'gameable/net/solo';
 *
 * console.log(staleGuestWarning({ builtAt: 1, sourceAt: 2, stale: true })); // 'Play Solo: ... STALE rules ...'
 * ```
 */
export function staleGuestWarning(status: GuestStatus): string | null {
  if (!status.stale) return null;
  if (status.builtAt === 0) {
    return (
      'Play Solo: there is no built guest, so the authority cannot start. ' +
      'Run `npm run build:guest`, then reload.'
    );
  }
  return (
    'Play Solo: the authority is running STALE rules. build/guest/ is older than the ' +
    "game's sources, so the authority runs the old game while this page runs the new one. " +
    'Run `npm run build:guest`, then reload.'
  );
}

/**
 * Ask the dev server whether the built guest is stale.
 *
 * @param fetchStatus The fetch to ask with. Default the page's `fetch`, uncached.
 * @returns The warning to show, or null: the guest is fresh, or the check itself failed (no dev server answers outside `npm run dev`).
 *
 * @example
 * ```ts
 * import { checkGuestStatus } from 'gameable/net/solo';
 *
 * const warning = await checkGuestStatus();
 * if (warning !== null) console.warn(warning);
 * ```
 */
export async function checkGuestStatus(
  fetchStatus: GuestStatusFetch = (path) => fetch(path, { cache: 'no-store' }),
): Promise<string | null> {
  try {
    const response = await fetchStatus(GUEST_STATUS_PATH);
    if (!response.ok) return null;
    const status = (await response.json()) as Partial<GuestStatus> | null;
    if (typeof status?.stale !== 'boolean' || typeof status.builtAt !== 'number') return null;
    return staleGuestWarning(status as GuestStatus);
  } catch {
    return null;
  }
}
