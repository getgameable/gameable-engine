/**
 * `WorldRecord` persistent visual state: materials, expressions, look-at and clip weights, and the snapshot.
 */
import { describe, expect, it } from 'vitest';

import { WorldRecord } from './WorldRecord';
import { depth, worldWithFive } from './worldRecordTesting';

describe('WorldRecord: persistent visual state', () => {
  it('keeps the latest material value per name and bumps only on change', () => {
    const { world, serial } = worldWithFive();
    const value = { tag: 'color' as const, val: { r: 1, g: 0, b: 0, a: 1 } };
    world.setMaterialParam(5, 'tint', value);
    world.setMaterialParam(5, 'gloss', { tag: 'scalar', val: 0.5 });
    value.val.g = 1; // the guest reuses its objects; the record must not alias them
    const visual = world.get(5)?.visual;
    expect(visual?.materials.map((m) => [m.name, m.value])).toEqual([
      ['tint', { tag: 'color', val: { r: 1, g: 0, b: 0, a: 1 } }],
      ['gloss', { tag: 'scalar', val: 0.5 }],
    ]);
    expect(visual?.serial).toBe(2);
    world.advance();
    world.setMaterialParam(5, 'gloss', { tag: 'scalar', val: 0.5 });
    expect(serial()).toBe(2);
    world.setMaterialParam(5, 'gloss', { tag: 'scalar', val: 0.75 });
    expect(serial()).toBe(3);
    expect(visual?.materials[1].serial).toBe(3);
    expect(visual?.materials[0].serial).toBe(2);
    expect(visual?.materials).toHaveLength(2);
  });

  it('keeps the latest expression per space, look-at and clip weights', () => {
    const { world, serial } = worldWithFive();
    world.setExpression(5, 'arkit52', Float32Array.of(0.25, 0.5));
    world.setExpression(5, 'gnm', [1]);
    world.lookAt(5, { x: 0, y: 1, z: 2 }, 0.5);
    world.setClipWeights(5, ['idle', 'walk'], [0.25, 0.75], 1);
    const visual = world.get(5)?.visual;
    expect(visual?.expressions.map((e) => [e.space, e.weights])).toEqual([
      ['arkit52', [0.25, 0.5]],
      ['gnm', [1]],
    ]);
    expect(visual?.lookAt).toMatchObject({ target: { x: 0, y: 1, z: 2 }, weight: 0.5 });
    expect(visual?.clipWeights).toMatchObject({
      clips: ['idle', 'walk'],
      weights: [0.25, 0.75],
      timeScale: 1,
    });
    world.advance();
    world.setExpression(5, 'arkit52', [0.25, 0.5]);
    world.lookAt(5, { x: 0, y: 1, z: 2 }, 0.5);
    world.setClipWeights(5, ['idle', 'walk'], [0.25, 0.75], 1);
    expect(serial()).toBe(2);
    world.lookAt(5, undefined, 0);
    expect(serial()).toBe(3);
    expect(visual?.lookAt?.target).toBeUndefined();
    expect(visual?.lookAt?.serial).toBe(3);
    expect(visual?.clipWeights?.serial).toBe(2);
  });

  it('ignores visual commands for entities that are not live', () => {
    const world = new WorldRecord();
    world.setMaterialParam(9, 'tint', { tag: 'scalar', val: 1 });
    world.lookAt(9, undefined, 0);
    expect(world.get(9)).toBeUndefined();
  });

  it('the snapshot carries the visual state, copied, and nests at most 8 deep', () => {
    const { world } = worldWithFive();
    world.setParent(5, 2);
    world.setAnim(5, 'walk', true, 1);
    world.setCharacter(5, 9);
    world.attachBody(11, 5);
    world.teleport(5);
    world.setMaterialParam(5, 'tint', { tag: 'color', val: { r: 1, g: 0, b: 0, a: 1 } });
    world.setMaterialParam(5, 'offset', { tag: 'vector', val: { x: 1, y: 2, z: 3 } });
    world.setExpression(5, 'arkit52', [0.5]);
    world.lookAt(5, { x: 0, y: 1, z: 2 }, 1);
    world.setClipWeights(5, ['idle'], [1], 1);
    const snap = world.snapshot();
    const live = world.get(5)!;
    live.visual.expressions[0].weights[0] = 9;
    const parsed = JSON.parse(JSON.stringify(snap)) as typeof snap;
    expect(parsed.entities[0].visual).toEqual({
      materials: [
        { name: 'tint', value: { tag: 'color', val: { r: 1, g: 0, b: 0, a: 1 } } },
        { name: 'offset', value: { tag: 'vector', val: { x: 1, y: 2, z: 3 } } },
      ],
      expressions: [{ space: 'arkit52', weights: [0.5] }],
      lookAt: { target: { x: 0, y: 1, z: 2 }, weight: 1 },
      clipWeights: { clips: ['idle'], weights: [1], timeScale: 1 },
    });
    expect(depth(parsed)).toBeLessThanOrEqual(8);
  });
});
