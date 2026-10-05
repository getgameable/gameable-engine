/**
 * `startPlaySolo` — Play Solo as a page starts it: under `npm run dev`, warn
 * first when the built guest is stale, then start the in-page authority, and
 * fail with the command to run when it cannot start.
 */
import { checkGuestStatus, type GuestStatusFetch } from './guestStatus.js';
import {
  createInPageAuthority,
  type InPageAuthority,
  type InPageAuthorityOptions,
} from './InPageAuthority.js';

/**
 * What {@link startPlaySolo} takes: the authority's options, plus the dev check.
 *
 * @example
 * ```ts
 * import type { PlaySoloOptions } from 'gameable/net/solo';
 *
 * const options: PlaySoloOptions = { guest, definition, dev: import.meta.env.DEV };
 * ```
 */
export interface PlaySoloOptions extends InPageAuthorityOptions {
  /** Ask the dev server whether the built guest is stale first. Pass `import.meta.env.DEV`. Default false. */
  dev?: boolean;
  /** Shows a warning. Default `console.warn`; a page also puts it on screen. */
  warn?: (message: string) => void;
  /** The fetch the dev check asks with. Default the page's `fetch`. */
  fetch?: GuestStatusFetch;
}

/** What a page is told when the authority cannot start. */
const CANNOT_START =
  'Play Solo could not start its authority. It runs the game built to wasm in every mode: ' +
  'run `npm run build:guest` (before `npm run dev` or `npm run build:direct`; `npm run build` runs it for you).';

/**
 * Start Play Solo's authority, as a page does.
 *
 * @param options The wasm guest, the definition, the manifest and physics, and the dev check.
 * @returns The started authority: join its `connection`, then `drive` it from the page's engine.
 * @throws {Error} When the guest cannot be loaded or dies on its first step; the message names the command to run.
 *
 * @example
 * ```ts
 * import { startPlaySolo } from 'gameable/net/solo';
 *
 * const solo = await startPlaySolo({ guest, definition, dev: import.meta.env.DEV, warn: showWarning });
 * ```
 */
export async function startPlaySolo(options: PlaySoloOptions): Promise<InPageAuthority> {
  const { dev, warn, fetch, ...authority } = options;
  if (dev === true) {
    const stale = await checkGuestStatus(fetch);
    if (stale !== null) (warn ?? console.warn)(stale);
  }
  const solo = createInPageAuthority(authority);
  try {
    await solo.start();
  } catch (error) {
    throw new Error(CANNOT_START, { cause: error });
  }
  return solo;
}
