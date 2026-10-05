import { describe, expect, it } from 'vitest';

import { createLoopbackConnection } from '../client/LoopbackConnection.js';
import { loopbackPair } from '../testing/index.js';
import { catalogName } from './catalogName.js';
import { chooseRoom } from './chooseRoom.js';
import { roomMode } from './roomMode.js';

describe('roomMode: what the address asks for', () => {
  it('no ?room= is Play Solo', () => {
    expect(roomMode('')).toEqual({ kind: 'solo' });
    expect(roomMode('?seed=4&test=1')).toEqual({ kind: 'solo' });
    expect(roomMode('?room=')).toEqual({ kind: 'solo' });
  });

  it('?room=CODE joins that room, trimmed and upper-cased', () => {
    expect(roomMode('?room=KQTX')).toEqual({ kind: 'join', code: 'KQTX' });
    expect(roomMode('?room=%20kqtx%20')).toEqual({ kind: 'join', code: 'KQTX' });
  });

  it('?room=new makes a room and ?room=quick is a quick match, in any case', () => {
    expect(roomMode('?room=new')).toEqual({ kind: 'new' });
    expect(roomMode('?room=NEW')).toEqual({ kind: 'new' });
    expect(roomMode('?room=quick')).toEqual({ kind: 'quick' });
    expect(roomMode(new URLSearchParams('room=Quick'))).toEqual({ kind: 'quick' });
  });
});

describe('catalogName: the game in the room server catalog', () => {
  it("is the package's name without its npm scope", () => {
    expect(catalogName('@gameable/example-mystery')).toBe('example-mystery');
    expect(catalogName('my-game')).toBe('my-game');
  });

  it('refuses an empty name', () => {
    expect(() => catalogName('@scope/')).toThrow(/catalog name/);
    expect(() => catalogName('')).toThrow(/catalog name/);
  });
});

describe('chooseRoom: the solo link or the room server', () => {
  const connection = createLoopbackConnection({ connect: () => loopbackPair()[0] });

  it('solo starts the in-page authority and hands its connection to multiplayer', async () => {
    let started = 0;
    const room = await chooseRoom(roomMode(''), {
      game: 'my-game',
      name: 'You',
      startSolo: () => {
        started += 1;
        return Promise.resolve({ connection });
      },
    });
    expect(started).toBe(1);
    expect(room.solo?.connection).toBe(connection);
    expect(room.multiplayer).toEqual({ connection, name: 'You' });
  });

  it('a room mode never starts the authority and names the catalog entry', async () => {
    const startSolo = (): Promise<{ connection: typeof connection }> => {
      throw new Error('must not start');
    };
    const options = { game: 'my-game', name: 'Ana', startSolo };
    const join = await chooseRoom(roomMode('?room=kqtx'), options);
    expect(join.solo).toBeNull();
    expect(join.multiplayer).toEqual({
      game: 'my-game',
      name: 'Ana',
      room: 'KQTX',
      newRoom: false,
    });
    expect((await chooseRoom(roomMode('?room=new'), options)).multiplayer).toEqual({
      game: 'my-game',
      name: 'Ana',
      newRoom: true,
    });
    expect((await chooseRoom(roomMode('?room=quick'), options)).multiplayer).toEqual({
      game: 'my-game',
      name: 'Ana',
      newRoom: false,
    });
  });
});
