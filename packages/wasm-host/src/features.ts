/**
 * The page's feature table (ADR 0017).
 *
 * Each entry is a dynamic import behind a factory, so a game that does not
 * declare a feature never downloads it. Import this module from
 * `gameable/host/features`, never from the package root.
 */
import { FeatureError, isRenderEngine } from '@gameable/core';
import type { Engine, FeatureTable, HeadlessEngine, LoadedFeature } from '@gameable/core';
import type { MultiplayerClientOptions } from '@gameable/net/client';
import type { LiveRoomList } from '@gameable/net/page';
import type { RoomsMultiplayerOptions } from '@gameable/rooms/client';

import type { CharacterBridgeOptions } from './characters';

/** What the page itself decides about the features it loads: options that cannot live in a game definition. */
export interface ClientFeatureOverrides {
  /** Bridge options a page owns (callbacks, head placement); the engine, renderer and scene are always the booted ones. */
  characters?: Omit<CharacterBridgeOptions, 'engine' | 'renderer' | 'scene'>;
  /**
   * The page's side of `multiplayer`: the player's name, the room code, and
   * the room server (`gameable/rooms/client`'s options; by default a
   * `ColyseusConnection` to `<page origin>/services/rooms/`, with the page's
   * `?room=`). A `connection` (Play Solo's loopback one) replaces all of that,
   * and then Colyseus is never downloaded. The game's `maxPlayers` and
   * `sendHz` come from its definition.
   */
  multiplayer?: Omit<RoomsMultiplayerOptions, 'maxPlayers' | 'sendHz'>;
}

/**
 * Features a browser host can load.
 *
 * @param overrides Host-side options for a feature, such as the character bridge's callbacks.
 * @returns The table for `resolveFeatures`.
 *
 * @example
 * ```ts
 * import { resolveFeatures } from 'gameable/core';
 * import { featuresOf } from 'gameable';
 * import { clientFeatures } from 'gameable/host/features';
 *
 * const loaded = await resolveFeatures(featuresOf(definition), clientFeatures());
 * // A multiplayer game joins the page's room server; the page names the player and the game:
 * // clientFeatures({ multiplayer: { name: 'Ana', game: 'party' } })
 * ```
 */
export function clientFeatures(overrides: ClientFeatureOverrides = {}): FeatureTable {
  return {
    characters: async (): Promise<LoadedFeature> => {
      const { createCharacterBridge } = await import('./characters');
      return {
        name: 'characters',
        modules: [],
        bind: (engine: Engine | HeadlessEngine) => {
          if (!isRenderEngine(engine)) {
            return Promise.reject(
              new FeatureError('characters needs a renderer; it cannot run headless'),
            );
          }
          return Promise.resolve(
            createCharacterBridge({
              ...overrides.characters,
              engine,
              renderer: engine.renderer,
              scene: engine.scene,
            }),
          );
        },
      };
    },
    multiplayer: async (options): Promise<LoadedFeature> => {
      const page = { ...(options as MultiplayerClientOptions), ...overrides.multiplayer };
      if (page.connection !== undefined) {
        const { multiplayer } = await import('@gameable/net/client'); // no Colyseus in this chunk
        return multiplayer(page);
      }
      const { multiplayer } = await import('@gameable/rooms/client');
      return multiplayer(page);
    },
  };
}

/**
 * Open a game's public room list, for the room badge's "Browse rooms" panel
 * (`attachRoomClient({ badge: { browse: { game, list: listPublicRooms } } })`).
 * The room server client is a dynamic import here, so a page downloads it
 * only when the panel opens.
 *
 * @param game The game's catalog name.
 * @param endpoint The room server (`roomsEndpoint(location.href)`).
 * @returns The live list (`gameable/rooms/client`'s `listRooms`).
 *
 * @example
 * ```ts
 * import { listPublicRooms } from 'gameable/host/features';
 *
 * const list = await listPublicRooms('my-game', 'wss://play.example/services/rooms/');
 * console.log(list.rooms);
 * list.close();
 * ```
 */
export async function listPublicRooms(game: string, endpoint: string): Promise<LiveRoomList> {
  const { listRooms } = await import('@gameable/rooms/client');
  return listRooms(game, { url: endpoint });
}
