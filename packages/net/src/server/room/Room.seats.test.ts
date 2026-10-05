/**
 * The room's seat count comes from one place: the game's
 * `features.multiplayer.maxPlayers` (sdk `roomSeats`), read by the guest for
 * its player slots and by `createEngineRoomGame` for the room's door.
 */
import { defineGame, type GameDefinition } from '@gameable/sdk';
import { describe, expect, it } from 'vitest';

import { PROTOCOL_VERSION } from '../../protocol/constants.js';
import { createEngineRoomGame } from './createEngineRoomGame.js';
import { createRoom } from './Room.js';
import { FakeGame, FakePorts } from './roomTesting.js';

const MANIFEST = { version: 1, assets: [{ id: 'arena', type: 'splat', src: 'a.spz' }] };
/** One fixed step, in ms. */
const MS = 1000 / 60;

/** @returns The tiny-game fixture's definition, loaded by URL. */
async function loadTinyGame(): Promise<GameDefinition> {
  const url = new URL('../../../../../fixtures/tiny-game/src/game.ts', import.meta.url);
  return ((await import(url.href)) as { default: GameDefinition }).default;
}

/**
 * @param seats The seats the game declares.
 * @returns The tiny game, declaring them.
 */
async function tinyWithSeats(seats: number): Promise<GameDefinition> {
  return defineGame({
    ...(await loadTinyGame()),
    features: { multiplayer: { maxPlayers: seats } },
  });
}

const hello = (name: string): string =>
  JSON.stringify({ t: 'hello', v: PROTOCOL_VERSION, room: 'ABCD', name });

/** A fake game that declares two seats. */
class TwoSeatGame extends FakeGame {
  get maxPlayers(): number {
    return 2;
  }
}

describe('seats from features.multiplayer.maxPlayers', () => {
  it('the room game and the room take the seats the game declares', async () => {
    const game = await createEngineRoomGame({
      definition: await tinyWithSeats(2),
      manifest: MANIFEST,
      seed: 7,
    });
    expect(game.maxPlayers).toBe(2);
    const ports = new FakePorts();
    const room = createRoom({ code: 'ABCD', game, ports, sendHz: 20 });
    room.handle('a', hello('A'));
    room.handle('b', hello('B'));
    room.handle('c', hello('C'));
    expect(ports.texts('c')).toEqual([{ t: 'error', code: 'full' }]);
    room.close('ended');
    await game.disposed;
  }, 60_000);

  it('the guest refuses a join past the declared seats', async () => {
    const game = await createEngineRoomGame({
      definition: await tinyWithSeats(2),
      manifest: MANIFEST,
      seed: 7,
    });
    game.join(1, 'B', null);
    game.join(2, 'Over', null);
    game.tick(0);
    game.tick(MS);
    expect(game.entityOf(1)).not.toBe(0);
    expect(game.entityOf(2)).toBe(0);
    game.dispose();
    await game.disposed;
  }, 60_000);

  it('a maxPlayers option of N seats gives the guest ids 0..N-1, not 0..N', async () => {
    const game = await createEngineRoomGame({
      definition: await loadTinyGame(),
      manifest: MANIFEST,
      maxPlayers: 2,
      seed: 7,
    });
    expect(game.maxPlayers).toBe(2);
    game.join(2, 'Over', null);
    game.tick(0);
    game.tick(MS);
    expect(game.entityOf(2)).toBe(0);
    game.dispose();
    await game.disposed;
  }, 60_000);

  it('refuses a wasm guest without maxPlayers instead of defaulting the seats', async () => {
    const guest = {
      guestModuleUrl: 'data:text/javascript,',
      getCoreModule: (): Promise<WebAssembly.Module> => Promise.reject(new Error('unused')),
    };
    await expect(createEngineRoomGame({ guest, manifest: MANIFEST })).rejects.toThrow(
      /wasm guest needs maxPlayers/,
    );
  });

  it('refuses a maxPlayers option that disagrees with the declared seats', async () => {
    await expect(
      createEngineRoomGame({
        definition: await tinyWithSeats(2),
        manifest: MANIFEST,
        maxPlayers: 4,
      }),
    ).rejects.toThrow(/maxPlayers/);
  });

  it('a room over a game that knows its seats needs no maxPlayers, and refuses one that disagrees', () => {
    const ports = new FakePorts();
    const room = createRoom({ code: 'ABCD', game: new TwoSeatGame(), ports, sendHz: 20 });
    room.handle('a', hello('A'));
    room.handle('b', hello('B'));
    room.handle('c', hello('C'));
    expect(ports.texts('c')).toEqual([{ t: 'error', code: 'full' }]);
    expect(() =>
      createRoom({ code: 'ABCD', game: new TwoSeatGame(), ports, maxPlayers: 3, sendHz: 20 }),
    ).toThrow(/maxPlayers/);
    expect(() => createRoom({ code: 'ABCD', game: new FakeGame(), ports, sendHz: 20 })).toThrow(
      /maxPlayers/,
    );
  });
});
