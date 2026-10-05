/**
 * `gameable/net/solo` — Play Solo: the game's authority in the page, as our
 * own `Room` over the wasm guest, joined over a loopback connection. A page
 * that joins a remote room never loads this entry (it carries the headless
 * engine, the room and a Jolt world).
 *
 * A page starts it with `startPlaySolo`, which first warns under `npm run dev`
 * when the built guest is older than the game's sources.
 *
 * @example
 * ```ts
 * import { createInPageAuthority } from 'gameable/net/solo';
 *
 * const solo = createInPageAuthority({ guest, definition, manifest, physicsOptions });
 * await solo.start();
 * solo.connection; // pass it to the page's multiplayer feature
 * ```
 */
export {
  createInPageAuthority,
  InPageAuthority,
  type InPageAuthorityOptions,
} from './InPageAuthority.js';
export type { WasmGuest } from '../server/room/createEngineRoomGame.js';
export {
  checkGuestStatus,
  GUEST_STATUS_PATH,
  staleGuestWarning,
  type GuestStatus,
  type GuestStatusFetch,
} from './guestStatus.js';
export { PageClock } from './PageClock.js';
export { SoloPorts } from './SoloPorts.js';
export { startPlaySolo, type PlaySoloOptions } from './startPlaySolo.js';
