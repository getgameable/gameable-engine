import { describe, expect, it } from 'vitest';
import { TRANSFORM_FLAGS } from '@gameable/sdk';

import { RowFlag } from '../../protocol/constants.js';
import { move, rowsOf, spawn, tags, world } from './replicatorTesting.js';

describe('Replicator: introductions', () => {
  it('introduces every live entity to a new player with its full state, parents first', () => {
    const { replicator, step } = world();
    step([spawn(11), spawn(12)]);
    step([
      { tag: 'set-parent', val: { entity: 11, parent: 12, keepWorldTransform: false } },
      { tag: 'set-anim', val: { entity: 12, clip: 'idle', looping: true, speed: 1, fadeMs: 0, weight: 1 } },
      { tag: 'spawn-character', val: { entity: 12, bundle: 4, position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 } } },
      { tag: 'set-expression', val: { entity: 12, space: 'arkit52', weights: [0.25] } },
    ]);
    replicator.add(2);
    step();
    const view = replicator.viewFor(2);
    expect(tags(view.commands)).toEqual([
      'spawn',
      'spawn-character',
      'set-anim',
      'set-character-state',
      'set-expression',
      'spawn',
    ]);
    expect(view.commands[0]).toMatchObject({ tag: 'spawn', val: { entity: 12, asset: 7, visible: true } });
    expect(view.commands[5]).toMatchObject({ tag: 'spawn', val: { entity: 11, parent: 12 } });
    expect(view.commands[4]).toEqual({
      tag: 'set-expression',
      val: { entity: 12, space: 'arkit52', weights: [0.25] },
    });
  });

  it('sends a spawn once, then only what changed', () => {
    const { replicator, step } = world();
    replicator.add(1);
    step([spawn(5)]);
    expect(tags(replicator.viewFor(1).commands)).toEqual(['spawn']);
    step();
    expect(replicator.viewFor(1).commands).toEqual([]);
  });

  it('covers every step since the last take', () => {
    const { replicator, step } = world();
    replicator.add(1);
    step([spawn(5)]);
    step([spawn(6)]);
    expect(replicator.viewFor(1).commands.map((c) => c.tag === 'spawn' && c.val.entity)).toEqual([5, 6]);
    expect(replicator.viewFor(1).commands).toEqual([]);
  });
});

describe('Replicator: changes', () => {
  it('a set-expression-only tick sends the visual command and no row', () => {
    const { replicator, step } = world();
    replicator.add(1);
    step([spawn(5)]);
    replicator.viewFor(1);
    replicator.viewFor(1).takeRows();
    step([{ tag: 'set-expression', val: { entity: 5, space: 'arkit52', weights: [0.5, 0.25] } }]);
    const view = replicator.viewFor(1);
    expect(view.commands).toEqual([
      { tag: 'set-expression', val: { entity: 5, space: 'arkit52', weights: [0.5, 0.25] } },
    ]);
    expect(view.takeRows().count).toBe(0);
  });

  it('a transform change sends a row and no command', () => {
    const { replicator, step } = world();
    replicator.add(1);
    step([spawn(5)]);
    replicator.viewFor(1).takeRows();
    step([], [move(5, 2)]);
    const view = replicator.viewFor(1);
    expect(view.commands).toEqual([]);
    const rows = view.takeRows();
    expect(rowsOf(rows)).toEqual([[5, RowFlag.POSITION | RowFlag.ROTATION]]);
    expect(rows.position(0)[0]).toBe(2);
    expect(view.takeRows().count).toBe(0);
  });

  it('sends rows for every move since the last rows, however many steps ago', () => {
    const { replicator, step } = world();
    replicator.add(1);
    step([spawn(5), spawn(6)]);
    replicator.viewFor(1).takeRows();
    step([], [move(5, 1)]);
    step([], [move(6, 1)]);
    step();
    expect(rowsOf(replicator.viewFor(1).takeRows()).map(([e]) => e).sort()).toEqual([5, 6]);
  });

  it('set-anim sends only set-anim', () => {
    const { replicator, step } = world();
    replicator.add(1);
    step([spawn(5)]);
    replicator.viewFor(1).takeRows();
    step([{ tag: 'set-anim', val: { entity: 5, clip: 'run', looping: true, speed: 1.5, fadeMs: 200, weight: 1 } }]);
    const view = replicator.viewFor(1);
    expect(view.commands).toEqual([
      { tag: 'set-anim', val: { entity: 5, clip: 'run', looping: true, speed: 1.5, fadeMs: 0, weight: 1 } },
    ]);
    expect(view.takeRows().count).toBe(0);
  });

  it('set-asset and set-parent become their commands', () => {
    const { replicator, step } = world();
    replicator.add(1);
    step([spawn(5), spawn(6)]);
    replicator.viewFor(1);
    step([
      { tag: 'set-asset', val: { entity: 5, asset: 9 } },
      { tag: 'set-parent', val: { entity: 5, parent: 6, keepWorldTransform: true } },
    ]);
    expect(replicator.viewFor(1).commands).toEqual([
      { tag: 'set-asset', val: { entity: 5, asset: 9 } },
      { tag: 'set-parent', val: { entity: 5, parent: 6, keepWorldTransform: false } },
    ]);
  });

  it('despawn sends despawn, and a respawn of the same id despawns then spawns', () => {
    const { replicator, step } = world();
    replicator.add(1);
    step([spawn(5), spawn(6)]);
    replicator.viewFor(1);
    step([{ tag: 'despawn', val: 5 }]);
    expect(replicator.viewFor(1).commands).toEqual([{ tag: 'despawn', val: 5 }]);
    step([spawn(6, { asset: 3 })]);
    const again = replicator.viewFor(1).commands;
    expect(tags(again)).toEqual(['despawn', 'spawn']);
    expect(again[1]).toMatchObject({ val: { entity: 6, asset: 3 } });
  });

  it('a teleport sets the snap flag on the next row', () => {
    const { replicator, step } = world();
    replicator.add(1);
    step([spawn(5)]);
    replicator.viewFor(1).takeRows();
    step([], [{ entity: 5, flags: TRANSFORM_FLAGS.POSITION | TRANSFORM_FLAGS.TELEPORT, at: [9, 0, 0] }]);
    expect(rowsOf(replicator.viewFor(1).takeRows())).toEqual([
      [5, RowFlag.POSITION | RowFlag.ROTATION | RowFlag.TELEPORT],
    ]);
  });

  it('a hidden entity shown later rides a VISIBLE row', () => {
    const { replicator, step } = world();
    replicator.add(1);
    step([spawn(5, { visible: false })]);
    replicator.viewFor(1).takeRows();
    step([], [{ entity: 5, flags: TRANSFORM_FLAGS.VISIBLE }]);
    const view = replicator.viewFor(1);
    expect(view.commands).toEqual([]);
    expect(rowsOf(view.takeRows())).toEqual([[5, RowFlag.VISIBLE]]);
  });
});
