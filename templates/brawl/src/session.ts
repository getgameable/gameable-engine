/**
 * The game's name in the room server's catalog, and the features the page
 * can load. Host code, split out of `src/main.ts` so it has no DOM.
 */
import type { FeatureTable } from 'gameable/core';
import { catalogName, type PageRoomOptions } from 'gameable/net/page';
import { clientFeatures } from 'gameable/host/features';

// Read at build time: Vite inlines this one field, not the whole file.
import { name as packageName } from '../package.json';

/**
 * This game's name in the room server's catalog: `package.json`'s name
 * without its scope. `gameable serve` registers the game under the same rule
 * (`catalogName` in `gameable/net/page`), so rename the package, not this.
 */
export const GAME_NAME = catalogName(packageName);

/**
 * The features this page can load; the game's `features` pick from them.
 *
 * @param multiplayer The room the page chose (`chooseRoom`).
 * @returns The table for `resolveFeatures`.
 */
export function pageFeatures(multiplayer: PageRoomOptions): FeatureTable {
  return clientFeatures({ multiplayer });
}
