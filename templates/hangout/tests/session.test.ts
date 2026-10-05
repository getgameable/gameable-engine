/**
 * The page's feature wiring, as `src/main.ts` runs it at boot: without a
 * `?room=` the page plays solo, and the `multiplayer` feature gets the in-page
 * authority's connection; any other mode names the room for the room server
 * client, under this game's catalog name. No browser and no guest build.
 */
import { resolveFeatures } from 'gameable/core';
import { createLoopbackConnection } from 'gameable/net/client';
import { catalogName, chooseRoom, roomMode } from 'gameable/net/page';
import { loopbackPair } from 'gameable/net/testing';
import { featuresOf } from 'gameable';
import { describe, expect, it } from 'vitest';

import { name } from '../package.json';
import game from '../src/game';
import { GAME_NAME, pageFeatures } from '../src/session';

const connection = createLoopbackConnection({ connect: () => loopbackPair()[0] });
const startSolo = (): Promise<{ connection: typeof connection }> => Promise.resolve({ connection });

describe('the page boot: which room, and the features it loads', () => {
  it("joins under the game's own name, package.json's without the scope", () => {
    // `template-hangout` here; a scaffolded game's own name after `create-gameable`.
    expect(GAME_NAME).toBe(catalogName(name));
    expect(GAME_NAME).not.toContain('/');
  });

  it('seats twelve, and loads characters and multiplayer with the solo connection', async () => {
    expect(featuresOf(game).multiplayer?.maxPlayers).toBe(12);
    const room = await chooseRoom(roomMode(''), { game: GAME_NAME, name: 'You', startSolo });
    const loaded = await resolveFeatures(featuresOf(game), pageFeatures(room));
    expect(loaded.map((feature) => feature.name).sort()).toEqual(['characters', 'multiplayer']);
    expect(connection.state).toBe('idle');
  });

  it('a ?room= page names the room and leaves the authority unloaded', async () => {
    const refuse = (): Promise<never> => Promise.reject(new Error('solo started'));
    for (const search of ['?room=KQTX', '?room=new', '?room=quick']) {
      const room = await chooseRoom(roomMode(search), {
        game: GAME_NAME,
        name: 'You',
        startSolo: refuse,
      });
      expect(room.solo).toBeNull();
      expect(room.multiplayer.game).toBe(GAME_NAME);
    }
  });
});
