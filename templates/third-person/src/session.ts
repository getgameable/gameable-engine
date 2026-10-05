/**
 * The page's boot decisions that follow from the game: is it multiplayer,
 * which host modules the page registers, which features it can load, and the
 * game's name in the room server's catalog.
 *
 * Host code, split out of `src/main.ts` so its decisions have a test
 * (`tests/session.test.ts`) without a browser.
 */
import type { EngineModule, FeatureTable } from 'gameable/core';
import { catalogName, type PageRoomOptions } from 'gameable/net/page';
import { featuresOf, type GameDefinition } from 'gameable';
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
 * True when the game declares `features.multiplayer` in `src/game.ts`.
 *
 * @param definition The game.
 * @returns Whether this page is a room's client.
 */
export function multiplayerOn(definition: GameDefinition): boolean {
  return featuresOf(definition).multiplayer !== undefined;
}

/**
 * True when the game declares `features.multiplayer.predict`: the page then
 * predicts its own player's character body (`gameable/net`'s client loop).
 *
 * @param definition The game.
 * @returns Whether this page predicts.
 */
export function predictOn(definition: GameDefinition): boolean {
  return featuresOf(definition).multiplayer?.predict === true;
}

/** The page's own host modules, before the features add theirs. */
export interface PageModuleParts {
  /** Makes the page's physics world. Called when multiplayer is off, or when the page predicts. */
  physics: () => EngineModule;
  /** Input, audio, splat: what every page registers. */
  others: readonly EngineModule[];
}

/**
 * The host modules this page registers. A multiplayer page registers no
 * physics: the authority's Jolt world (in this page under Play Solo, on the
 * room server online) is the only one, and a client never steps it. Unless it
 * predicts: then the page has its own world again, holding only the level's
 * static collider and the character body the client guest adds for this
 * page's player, and the client loop steps and corrects it.
 *
 * @param online `multiplayerOn(definition)`.
 * @param parts The module factories.
 * @param predict `predictOn(definition)`.
 * @returns The modules, in registration order.
 */
export function pageModules(
  online: boolean,
  parts: PageModuleParts,
  predict = false,
): EngineModule[] {
  return online && !predict ? [...parts.others] : [parts.physics(), ...parts.others];
}

/**
 * The features this page can load; the game's `features` pick from them. The
 * head offset is only used by the `?gnm=1` guide: a splat head has to be told
 * where the neck is, a skinned rig brings its own.
 *
 * @param multiplayer The room the page chose (`chooseRoom`), when multiplayer is on.
 * @returns The table for `resolveFeatures`.
 */
export function pageFeatures(multiplayer?: PageRoomOptions): FeatureTable {
  return clientFeatures({
    characters: { headOffset: [0, 0.78, 0] },
    ...(multiplayer === undefined ? {} : { multiplayer }),
  });
}
