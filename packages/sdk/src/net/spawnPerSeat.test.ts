import { beforeEach, describe, expect, it } from 'vitest';

import { defineGame, type GameContext } from '../defineGame';
import { Transform } from '../ecs';
import { prefab, resetPrefabRegistry } from '../prefab';
import { createGuest } from '../runtime';
import { createStubHost, stubConfig } from '../testing';
import { joined, rig, roomFrame } from './netTesting';
import type { PlayerSpec } from '../defineGame';
import type { Vec3 } from '../types';

const AUTHORITY = '{"net":{"role":"authority"}}';

/**
 * Join seats 0..n-1 on an authority and read where each one's entity stands.
 *
 * @param spawn The `player.spawn` under test.
 * @param n How many seats join.
 * @returns `[x, y, z]` per seat, in seat order.
 */
function spawnedAt(spawn: PlayerSpec['spawn'], n: number): number[][] {
  const Avatar = prefab({ name: 'avatar' });
  const { guest, ctx } = rig({ player: { prefab: Avatar, spawn } }, AUTHORITY);
  const events = [];
  for (let seat = 0; seat < n; seat += 1) events.push(joined(seat));
  guest.tick(roomFrame(0, events));
  const out: number[][] = [];
  for (let seat = 0; seat < n; seat += 1) {
    const e = ctx().players.get(seat)?.entity ?? 0;
    out.push([Transform.x[e], Transform.y[e], Transform.z[e]]);
  }
  return out;
}

describe('player.spawn per seat', () => {
  beforeEach(() => {
    resetPrefabRegistry();
  });

  it('puts every seat on a single point, as before', () => {
    expect(spawnedAt([1, 2, 3], 2)).toEqual([
      [1, 2, 3],
      [1, 2, 3],
    ]);
  });

  it('gives seat i the point list[i % n]', () => {
    const list = [
      [1, 0, 0],
      [2, 0, 0],
      [3, 0, 0],
    ];
    expect(spawnedAt(list, 4).map((p) => p[0])).toEqual([1, 2, 3, 1]);
  });

  it('asks a function for each seat, handing it the seat and the context', () => {
    const seen: number[] = [];
    const at = (seat: number, ctx: GameContext): Vec3 => {
      seen.push(seat);
      return { x: seat * 10, y: Number(ctx.rules.floor ?? 0), z: 0 };
    };
    expect(spawnedAt(at, 3).map((p) => p[0])).toEqual([0, 10, 20]);
    expect(seen).toEqual([0, 1, 2]);
  });

  it('spawns the solo player at seat 0 of a list or a function', () => {
    const Avatar = prefab({ name: 'avatar' });
    const list = defineGame({
      player: {
        prefab: Avatar,
        spawn: [
          [4, 5, 6],
          [7, 8, 9],
        ],
      },
    });
    const guest = createGuest(createStubHost(), list);
    guest.init(stubConfig());
    const e = guest.state.player;
    expect([Transform.x[e], Transform.y[e], Transform.z[e]]).toEqual([4, 5, 6]);

    resetPrefabRegistry();
    const fn = defineGame({
      player: { prefab: Avatar, spawn: (seat) => ({ x: 7, y: seat, z: 1 }) },
    });
    const solo = createGuest(createStubHost(), fn);
    solo.init(stubConfig());
    const s = solo.state.player;
    expect([Transform.x[s], Transform.y[s], Transform.z[s]]).toEqual([7, 0, 1]);
  });

  it('is deterministic: a seat function drawing from ctx.rng spawns the same twice', () => {
    const at = (_seat: number, ctx: GameContext): Vec3 => ({ x: ctx.rng.float(), y: 0, z: 0 });
    const first = spawnedAt(at, 3);
    resetPrefabRegistry();
    expect(spawnedAt(at, 3)).toEqual(first);
  });
});
