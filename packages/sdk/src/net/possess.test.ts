import { beforeEach, describe, expect, it } from 'vitest';

import { AUTHORITY_SENDER } from '../index';
import { prefab, resetPrefabRegistry } from '../prefab';
import { joined, payloads, rig, roomFrame } from './netTesting';
import type { GameContext } from '../defineGame';
import type { SetPlayerEntityCmd } from '../types';

const AUTHORITY = '{"net":{"role":"authority"}}';

describe('which entity a player controls (set-player-entity)', () => {
  beforeEach(() => {
    resetPrefabRegistry();
  });

  it('the join spawn of definition.player tells the host the player entity', () => {
    const Avatar = prefab({ name: 'avatar' });
    const { guest, ctx } = rig({ player: { prefab: Avatar } }, AUTHORITY);
    guest.tick(roomFrame(0));
    const out = guest.tick(roomFrame(1, [joined(3, 'ada')]));
    const entity = ctx().players.get(3)?.entity ?? 0;
    expect(entity).not.toBe(0);
    expect(payloads<SetPlayerEntityCmd>(out.commands, 'set-player-entity')).toEqual([{ player: 3, entity }]);
  });

  it('possess(entity) moves the player to another entity and tells the host', () => {
    const Avatar = prefab({ name: 'avatar' });
    const Car = prefab({ name: 'car' });
    let car = 0;
    const { guest, ctx } = rig(
      {
        player: { prefab: Avatar },
        systems: [
          {
            on: 'authority',
            run: (c: GameContext) => {
              if (c.frame !== 2) return;
              car = c.spawn(Car, { x: 0, y: 0, z: 0 });
              c.players.get(3)?.possess(car);
            },
          },
        ],
      },
      AUTHORITY,
    );
    guest.tick(roomFrame(0));
    guest.tick(roomFrame(1, [joined(3)]));
    const out = guest.tick(roomFrame(2));
    expect(ctx().players.get(3)?.entity).toBe(car);
    expect(ctx().playerEntity(3)).toBe(car);
    expect(payloads<SetPlayerEntityCmd>(out.commands, 'set-player-entity')).toEqual([{ player: 3, entity: car }]);
  });

  it('despawning the possessed entity leaves the player with no entity', () => {
    const Avatar = prefab({ name: 'avatar' });
    const { guest, ctx } = rig(
      {
        player: { prefab: Avatar },
        systems: [
          {
            on: 'authority',
            run: (c: GameContext) => {
              if (c.frame === 2) c.despawn(c.playerEntity(3));
            },
          },
        ],
      },
      AUTHORITY,
    );
    guest.tick(roomFrame(0));
    guest.tick(roomFrame(1, [joined(3)]));
    guest.tick(roomFrame(2));
    expect(ctx().players.get(3)?.entity).toBe(0);
    expect(ctx().playerEntity(3)).toBe(0);
  });

  it('exports the authority sender id the room puts on its messages', () => {
    expect(AUTHORITY_SENDER).toBe(0xffffffff);
  });
});
