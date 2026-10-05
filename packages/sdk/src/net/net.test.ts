import { beforeEach, describe, expect, it } from 'vitest';

import { Health } from '../ecs';
import { prefab, resetPrefabRegistry } from '../prefab';
import { joined, left, payloads, rig, roomFrame } from './netTesting';
import type { GameContext } from '../defineGame';
import type { SendCmd, SetPlayerHudCmd, SpawnCmd } from '../types';

const AUTHORITY = '{"net":{"role":"authority"}}';
const CLIENT = '{"net":{"role":"client","localPlayer":2}}';

describe('ctx.net role', () => {
  it('reads the role and the local player from game-config.options', () => {
    const client = rig({}, CLIENT);
    client.guest.tick(roomFrame(0));
    expect(client.ctx().net.role).toBe('client');
    expect(client.ctx().net.localPlayer).toBe(2);
    expect(client.ctx().net.isAuthority).toBe(false);

    const solo = rig({});
    solo.guest.tick(roomFrame(0));
    expect(solo.ctx().net.role).toBe('solo');
    expect(solo.ctx().net.localPlayer).toBe(0);
    expect(solo.ctx().net.isAuthority).toBe(true);
    expect(solo.ctx().localPlayer).toBeNull();
  });
});

describe('sided systems', () => {
  /**
   * Run one tick of a game with an authority, a client and a bare system.
   *
   * @param options The options JSON, or undefined for solo.
   * @returns Which systems ran.
   */
  function ran(options?: string): string[] {
    const seen: string[] = [];
    const a = (): void => {
      seen.push('a');
    };
    const b = (): void => {
      seen.push('b');
    };
    const c = (): void => {
      seen.push('c');
    };
    const { guest } = rig(
      {
        features: { multiplayer: true },
        systems: [{ run: a, on: 'authority' }, { run: b, on: 'client' }, c],
      },
      options,
    );
    guest.tick(roomFrame(0));
    return seen;
  }

  it('runs the authority and bare systems on the authority', () => {
    expect(ran(AUTHORITY)).toEqual(['a', 'c']);
  });

  it('runs only the client system on a client', () => {
    expect(ran(CLIENT)).toEqual(['b']);
  });

  it('runs all three in solo, which is the authority and its own client', () => {
    expect(ran()).toEqual(['a', 'b', 'c']);
  });
});

describe('per-player spawn', () => {
  beforeEach(() => {
    resetPrefabRegistry();
  });

  it('spawns definition.player on player-joined and despawns it on player-left', () => {
    const Avatar = prefab({ name: 'avatar', health: 50 });
    const { guest, ctx } = rig({ player: { prefab: Avatar, spawn: [1, 0, 2] } }, AUTHORITY);

    const first = guest.tick(roomFrame(0));
    expect(payloads<SpawnCmd>(first.commands, 'spawn')).toHaveLength(0);
    expect(ctx().player).toBe(0);

    const join = guest.tick(roomFrame(1, [joined(3, 'ada')]));
    const handle = ctx().players.get(3);
    expect(handle?.entity).not.toBe(0);
    expect(handle?.name).toBe('ada');
    expect(handle?.connected).toBe(true);
    expect(ctx().playerEntity(3)).toBe(handle?.entity);
    expect(Health.current[handle?.entity ?? 0]).toBe(50);
    expect(payloads<SpawnCmd>(join.commands, 'spawn')).toHaveLength(1);

    const entity = handle?.entity ?? 0;
    const leave = guest.tick(roomFrame(2, [left(3)]));
    expect(payloads<number>(leave.commands, 'despawn')).toEqual([entity]);
    expect(handle?.connected).toBe(false);
    expect(handle?.entity).toBe(0);
    expect(ctx().players.has(3)).toBe(false);
    expect(ctx().playerEntity(3)).toBe(0);
  });

  it('keeps spawning the single player at init in solo', () => {
    const Avatar = prefab({ name: 'avatar' });
    const { guest, ctx } = rig({ player: { prefab: Avatar } });
    const out = guest.tick(roomFrame(0, [joined(3)]));
    expect(ctx().player).not.toBe(0);
    expect(payloads<SpawnCmd>(out.commands, 'spawn')).toHaveLength(1);
  });
});

describe('per-player hud', () => {
  it('emits set-player-hud for that player and no frame hud', () => {
    const { guest } = rig(
      {
        systems: [
          {
            on: 'authority',
            run: (ctx: GameContext) => {
              ctx.players.get(3)?.hud.set({ role: 'murderer' });
            },
          },
        ],
      },
      AUTHORITY,
    );
    const out = guest.tick(roomFrame(0, [joined(3)]));
    expect(payloads<SetPlayerHudCmd>(out.commands, 'set-player-hud')).toEqual([
      { player: 3, hud: '{"role":"murderer"}' },
    ]);
    expect(out.hud).toBeUndefined();

    // Unchanged on the next tick: nothing crosses.
    const again = guest.tick(roomFrame(1));
    expect(payloads(again.commands, 'set-player-hud')).toHaveLength(0);
  });
});

describe('ctx.net.send', () => {
  /**
   * @param options The options JSON.
   * @returns The send commands one tick produced.
   */
  function sends(options: string): SendCmd[] {
    const { guest } = rig(
      {
        systems: [
          {
            on: 'both',
            run: (ctx: GameContext) => {
              ctx.net.send('vote', { for: 1 }, { to: 3 });
            },
          },
        ],
      },
      options,
    );
    return payloads<SendCmd>(guest.tick(roomFrame(0)).commands, 'send');
  }

  it('sends to one player, reliable by default, on the authority', () => {
    expect(sends(AUTHORITY)).toEqual([
      { to: 3, name: 'vote', payload: '{"for":1}', reliable: true },
    ]);
  });

  it('ignores `to` on a client and still sends', () => {
    expect(sends(CLIENT)).toEqual([
      { to: undefined, name: 'vote', payload: '{"for":1}', reliable: true },
    ]);
  });
});

describe('ctx.net.local', () => {
  beforeEach(() => {
    resetPrefabRegistry();
  });

  it('routes the commands queued inside it to localCommands', () => {
    const Marker = prefab({ name: 'marker' });
    const p = { x: 0, y: 0, z: 0 };
    const { guest } = rig(
      {
        systems: [
          {
            on: 'authority',
            run: (ctx: GameContext) => {
              if (ctx.frame === 0) ctx.net.local(() => ctx.spawn(Marker, p));
            },
          },
        ],
      },
      AUTHORITY,
    );
    const out = guest.tick(roomFrame(0));
    expect(payloads(out.localCommands, 'spawn')).toHaveLength(1);
    expect(payloads(out.commands, 'spawn')).toHaveLength(0);
  });
});
