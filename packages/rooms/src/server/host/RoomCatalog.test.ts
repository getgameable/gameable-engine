import type { RoomGame } from '@gameable/net/server';
import { describe, expect, it } from 'vitest';

import { StubGame } from '../testing/StubGame.js';
import { createRoomCatalog, type GameSetup } from './RoomCatalog.js';

describe('RoomCatalog', () => {
  it('decides maxPlayers once: the entry and the game it builds get the same number', async () => {
    const seen: GameSetup[] = [];
    const catalog = createRoomCatalog({
      duel: {
        maxPlayers: 2,
        create: (setup): RoomGame => {
          seen.push(setup);
          return new StubGame();
        },
      },
    });
    const entry = catalog.entry('duel');
    expect(entry.maxPlayers).toBe(2);
    await entry.create();
    expect(seen).toEqual([{ maxPlayers: 2 }]);
  });

  it('registers a game once', () => {
    const catalog = createRoomCatalog();
    const game = { maxPlayers: 4, create: (): RoomGame => new StubGame() };
    catalog.register('party', game);
    expect(() => catalog.register('party', game)).toThrow(/already registered/);
    expect(catalog.names()).toEqual(['party']);
  });

  it('refuses a bad name, the reserved lobby name, and a bad maxPlayers', () => {
    const catalog = createRoomCatalog();
    const create = (): RoomGame => new StubGame();
    expect(() => catalog.register('has space', { maxPlayers: 2, create })).toThrow(/name/);
    expect(() => catalog.register('lobby', { maxPlayers: 2, create })).toThrow(/reserved/);
    expect(() => catalog.register('zero', { maxPlayers: 0, create })).toThrow(/maxPlayers/);
    expect(() => catalog.register('half', { maxPlayers: 1.5, create })).toThrow(/maxPlayers/);
    expect(() => catalog.entry('missing')).toThrow(/no game/);
  });

  it('gives each entry the server-wide hold unless the game sets its own', () => {
    const create = (): RoomGame => new StubGame();
    const catalog = createRoomCatalog(
      { a: { maxPlayers: 2, create }, b: { maxPlayers: 2, reconnectSeconds: 5, create } },
      { reconnectSeconds: 12 },
    );
    expect(catalog.entry('a').reconnectSeconds).toBe(12);
    expect(catalog.entry('b').reconnectSeconds).toBe(5);
  });
});
