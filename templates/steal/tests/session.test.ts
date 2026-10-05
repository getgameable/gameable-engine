/**
 * The page's feature wiring, as `src/main.ts` runs it at boot: without a
 * `?room=` the page plays solo, and the `multiplayer` feature gets the in-page
 * authority's connection; any other mode names the room for the room server
 * client, under this game's catalog name. No browser and no guest build: the
 * connection is a real loopback connection that is never joined (joining is
 * the `net` module's `init`, after boot).
 */
import { resolveFeatures } from 'gameable/core';
import { createLoopbackConnection } from 'gameable/net/client';
import { catalogName, chooseRoom, roomMode } from 'gameable/net/page';
import { loopbackPair } from 'gameable/net/testing';
import { featuresOf } from 'gameable';
import { describe, expect, it } from 'vitest';

import { name as packageName } from '../package.json';
import game from '../src/game';
import { GAME_NAME, pageFeatures } from '../src/session';

/** What the catalog calls this game: `template-steal` here, your package's name once scaffolded. */
const NAME = catalogName(packageName);

const connection = createLoopbackConnection({ connect: () => loopbackPair()[0] });
const startSolo = (): Promise<{ connection: typeof connection }> => Promise.resolve({ connection });

describe('the page boot: which room, and the features it loads', () => {
  it("joins under the game's real name: package.json's, without the scope", () => {
    expect(GAME_NAME).toBe(NAME);
    expect(NAME).not.toContain('/');
  });

  it("resolves the game's features with the solo authority's connection", async () => {
    const room = await chooseRoom(roomMode(''), { game: GAME_NAME, name: 'You', startSolo });
    const loaded = await resolveFeatures(featuresOf(game), pageFeatures(room));
    expect(loaded.map((feature) => feature.name).sort()).toEqual(['characters', 'multiplayer']);
    const net = loaded.find((feature) => feature.name === 'multiplayer');
    expect(net?.modules.map((module) => module.id)).toEqual(['net']);
    expect(connection.state).toBe('idle');
  });

  it('a ?room= page names the room and the catalog entry, and leaves the authority unloaded', async () => {
    const refuse = (): Promise<never> => Promise.reject(new Error('solo started'));
    for (const search of ['?room=KQTX', '?room=new', '?room=quick']) {
      const room = await chooseRoom(roomMode(search), {
        game: GAME_NAME,
        name: 'You',
        startSolo: refuse,
      });
      expect(room.solo).toBeNull();
      expect(room.multiplayer.game).toBe(NAME);
      expect(typeof pageFeatures(room).multiplayer).toBe('function');
    }
  });
});
