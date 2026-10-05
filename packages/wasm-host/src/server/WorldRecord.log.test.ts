/**
 * `WorldRecord`'s tick log (spawns and despawns), and the change paths allocating nothing once warm.
 */
import { describe, expect, it } from 'vitest';

import { WorldRecord } from './WorldRecord';
import { heapUsed, identity, origin, unit } from './worldRecordTesting';

describe('WorldRecord: the tick log', () => {
  it('lists this tick spawns and despawns, and forgets them on advance', () => {
    const world = new WorldRecord();
    world.advance();
    world.spawn(5, 7, origin, identity, unit, { visible: true });
    world.spawn(6, 7, origin, identity, unit, { visible: true });
    expect(world.spawned).toEqual([5, 6]);
    expect(world.despawned).toEqual([]);
    world.advance();
    expect(world.spawned).toEqual([]);
    world.despawn(5);
    world.despawn(5);
    expect(world.despawned).toEqual([5]);
    world.advance();
    expect(world.despawned).toEqual([]);
  });

  it('an entity born and gone in one tick is in neither list', () => {
    const world = new WorldRecord();
    world.advance();
    world.spawn(5, 7, origin, identity, unit, { visible: true });
    world.despawn(5);
    expect(world.spawned).toEqual([]);
    expect(world.despawned).toEqual([]);
  });

  it('a respawn of an older entity is a despawn and a spawn', () => {
    const world = new WorldRecord();
    world.advance();
    world.spawn(5, 7, origin, identity, unit, { visible: true });
    world.advance();
    world.spawn(5, 8, origin, identity, unit, { visible: true });
    expect(world.despawned).toEqual([5]);
    expect(world.spawned).toEqual([5]);
    expect(world.get(5)?.spawnedAt).toBe(2);
  });

  it('reuses its arrays from tick to tick', () => {
    const world = new WorldRecord();
    const spawned = world.spawned;
    const despawned = world.despawned;
    world.advance();
    world.spawn(5, 7, origin, identity, unit, { visible: true });
    world.advance();
    world.despawn(5);
    world.advance();
    expect(world.spawned).toBe(spawned);
    expect(world.despawned).toBe(despawned);
  });
});

describe('WorldRecord: the change paths allocate nothing once warm', () => {
  it('a steady stream of changes and repeats keeps the heap flat', () => {
    const world = new WorldRecord();
    world.advance();
    world.spawn(5, 7, origin, identity, unit, { visible: true });
    world.attachBody(11, 5);
    const color = { tag: 'color' as const, val: { r: 0, g: 0, b: 0, a: 1 } };
    const target = { x: 0, y: 0, z: 0 };
    const weights = [0, 0, 0];
    const clips = ['idle', 'walk'];
    const blend = [1, 0];
    const tick = (i: number): void => {
      world.advance();
      const odd = (i & 1) === 1;
      world.setAnim(5, odd ? 'walk' : 'idle', true, 1);
      world.setCharacterState(5, odd ? 'run' : 'idle', true);
      color.val.r = i;
      world.setMaterialParam(5, 'tint', color);
      world.setMaterialParam(5, 'gloss', { tag: 'scalar', val: 1 });
      weights[0] = i;
      world.setExpression(5, 'arkit52', weights);
      target.x = i;
      world.lookAt(5, odd ? target : undefined, 1);
      blend[0] = odd ? 1 : 0;
      world.setClipWeights(5, clips, blend, 1);
      world.teleport(5);
    };
    for (let i = 0; i < 2000; i += 1) tick(i);
    const gc = (globalThis as { gc?: () => void }).gc;
    gc?.();
    const before = heapUsed();
    for (let i = 0; i < 20000; i += 1) tick(i);
    gc?.();
    const after = heapUsed();
    // 20,000 ticks of even one small object each is ~1 MB; without
    // `--expose-gc` V8 collects when it likes, so the bound is looser.
    const limit = gc === undefined ? 4 * 1024 * 1024 : 256 * 1024;
    expect(after - before).toBeLessThan(limit);
    expect(world.get(5)?.visual.materials).toHaveLength(2);
  });
});
