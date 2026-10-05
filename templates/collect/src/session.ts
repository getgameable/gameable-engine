/**
 * The feature table that follows from the page's room, and the catalog name
 * it joins under. The `?room=` modes themselves are `gameable/net/page`'s.
 *
 * Host code, split out of `src/main.ts` so its boot decision has a test
 * (`tests/session.test.ts`) without a browser.
 */
import type { FeatureTable } from 'gameable/core';
import { catalogName, type ChosenRoom, type SoloLink } from 'gameable/net/page';
import { clientFeatures } from 'gameable/host/features';

// Read at build time: Vite inlines this one field, not the whole file.
import { name as packageName } from '../package.json';

/**
 * This game's name in the room server's catalog: `package.json`'s name
 * without its scope (`template-collect`). `gameable serve` registers it under
 * the same rule (`catalogName` in `gameable/net/page`).
 */
export const GAME_NAME = catalogName(packageName);

/**
 * The features this page can load; the game's `features` pick from them.
 *
 * Solo: `multiplayer` joins the room running in this page. Any other mode
 * passes the catalog name and the room it asked for, and `clientFeatures`'
 * default `multiplayer` joins the room server at `<page origin>/services/rooms/`
 * (or a local page's `?rooms=`).
 *
 * @param room The page's room, from `chooseRoom`.
 * @returns The table for `resolveFeatures`.
 */
export function pageFeatures(room: Pick<ChosenRoom<SoloLink>, 'multiplayer'>): FeatureTable {
  return clientFeatures({ multiplayer: room.multiplayer });
}
