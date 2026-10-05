import { beforeEach, describe, expect, it } from 'vitest';

import { DEFAULT_ROOM_SEATS, defineGame, roomSeats } from '../index';
import { parseMaxPlayers, parseNetOptions } from './roles';
import { prefab, resetPrefabRegistry } from '../prefab';
import { joined, rig, roomFrame } from './netTesting';

const AUTHORITY = '{"net":{"role":"authority"}}';

describe('features.multiplayer.maxPlayers', () => {
  beforeEach(() => {
    resetPrefabRegistry();
  });

  it('is the seat count every side reads: roomSeats', () => {
    expect(roomSeats(defineGame({ features: { multiplayer: { maxPlayers: 3 } } }))).toBe(3);
    expect(roomSeats(defineGame({ features: { multiplayer: true } }))).toBe(DEFAULT_ROOM_SEATS);
    expect(roomSeats(defineGame({}))).toBeUndefined();
    expect(roomSeats(defineGame({ features: { multiplayer: false } }))).toBeUndefined();
    expect(() => roomSeats(defineGame({ features: { multiplayer: { maxPlayers: 0 } } }))).toThrow(
      /maxPlayers/,
    );
  });

  it('accepts 4097 seats (ids up to the 4096 ceiling) and refuses 4098', () => {
    expect(roomSeats(defineGame({ features: { multiplayer: { maxPlayers: 4097 } } }))).toBe(4097);
    expect(() =>
      roomSeats(defineGame({ features: { multiplayer: { maxPlayers: 4098 } } })),
    ).toThrow(/maxPlayers/);
    expect(() => roomSeats(defineGame({ features: { multiplayer: { maxPlayers: 1.5 } } }))).toThrow(
      /maxPlayers/,
    );
  });

  it('throws for a client whose localPlayer is past the declared seats', () => {
    const client = (local: number): string =>
      JSON.stringify({ net: { role: 'client', localPlayer: local } });
    expect(parseNetOptions(client(1), 2).localPlayer).toBe(1);
    expect(() => parseNetOptions(client(2), 2)).toThrow(/past the game's 2 seats/);
  });

  it('parseMaxPlayers takes the declared seats too', () => {
    expect(parseMaxPlayers('{"net":{"maxPlayers":16}}', 3)).toBe(2);
    expect(parseMaxPlayers(undefined, 3)).toBe(2);
  });

  it('refuses a join past the cap at the guest: no player, no entity, one warning', () => {
    const Avatar = prefab({ name: 'avatar' });
    const { guest, ctx, host } = rig(
      { features: { multiplayer: { maxPlayers: 2 } }, player: { prefab: Avatar } },
      AUTHORITY,
    );
    guest.tick(roomFrame(0, [joined(0), joined(1), joined(2)]));
    expect([...ctx().players.keys()]).toEqual([0, 1]);
    expect(ctx().playerEntity(2)).toBe(0);
    expect(host.lines.filter((l) => l.includes('maxPlayers'))).toHaveLength(1);
  });

  it('raises the guest past the default net cap when the game declares more seats', () => {
    const { guest, ctx } = rig({ features: { multiplayer: { maxPlayers: 40 } } }, AUTHORITY);
    guest.tick(roomFrame(0, [joined(39)]));
    expect([...ctx().players.keys()]).toEqual([39]);
  });

  it('wins over a larger net.maxPlayers the room passes', () => {
    const { guest, ctx } = rig(
      { features: { multiplayer: { maxPlayers: 2 } } },
      '{"net":{"role":"authority","maxPlayers":16}}',
    );
    guest.tick(roomFrame(0, [joined(1), joined(5)]));
    expect([...ctx().players.keys()]).toEqual([1]);
  });
});
