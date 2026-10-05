import { beforeEach, describe, expect, it } from 'vitest';

import { entityExists } from '../ecs';
import { prefab, resetPrefabRegistry } from '../prefab';
import { joined, left, payloads, rig, roomFrame } from './netTesting';
import type { SpawnCmd } from '../types';

const AUTHORITY = '{"net":{"role":"authority"}}';

describe('snapshot and restore with players', () => {
  beforeEach(() => {
    resetPrefabRegistry();
  });

  /** @returns A rig whose authority spawns an avatar per joined player. */
  function room(): ReturnType<typeof rig> {
    const Avatar = prefab({ name: 'avatar', health: 10 });
    return rig({ player: { prefab: Avatar } }, AUTHORITY);
  }

  it('a player who joined after the snapshot is gone after restore, and rejoins fresh', () => {
    const { guest, ctx } = room();
    guest.tick(roomFrame(0));
    const before = guest.snapshot();

    guest.tick(roomFrame(1, [joined(3)]));
    expect(ctx().players.get(3)?.entity).not.toBe(0);

    guest.restore(before);
    const handle = ctx().players.get(3);
    expect(handle).toBeUndefined();
    expect(ctx().playerEntity(3)).toBe(0);

    const out = guest.tick(roomFrame(2, [joined(3)]));
    expect(payloads<SpawnCmd>(out.commands, 'spawn')).toHaveLength(1);
    expect(ctx().players.get(3)?.entity).not.toBe(0);
  });

  it('a player who left after the snapshot is back after restore, on a living entity', () => {
    const { guest, ctx } = room();
    guest.tick(roomFrame(0, [joined(3, 'ada')]));
    const entity = ctx().players.get(3)?.entity ?? 0;
    expect(entity).not.toBe(0);
    const before = guest.snapshot();

    guest.tick(roomFrame(1, [left(3)]));
    expect(ctx().players.has(3)).toBe(false);

    guest.restore(before);
    guest.tick(roomFrame(2));
    const handle = ctx().players.get(3);
    expect(handle?.connected).toBe(true);
    expect(handle?.name).toBe('ada');
    expect(handle?.entity).toBe(entity);
    expect(entityExists(ctx().world as never, entity)).toBe(true);
  });

  it('still restores a version 2 snapshot, with every seat empty', () => {
    const { guest, ctx } = room();
    guest.tick(roomFrame(0));
    const old = guest.snapshot();
    new DataView(old.buffer, old.byteOffset).setUint32(4, 2, true);
    guest.tick(roomFrame(1, [joined(3)]));
    expect(() => {
      guest.restore(old);
    }).not.toThrow();
    expect(ctx().players.has(3)).toBe(false);
  });
});
