/**
 * An asset-less, characterless entity (a steal-kit base, belt or
 * brainrot) has no model for a client to draw, so a player's page needs the
 * authority's `add-body` shape to stand a placeholder in for it.
 */
import { describe, expect, it } from 'vitest';
import type { Command } from '@gameable/sdk';

import { tags, world } from './replicatorTesting.js';

/**
 * @param entity Entity id.
 * @returns A `spawn` with no `asset`, unlike `replicatorTesting.spawn`'s default 7.
 */
const spawnNoAsset = (entity: number): Command => ({
  tag: 'spawn',
  val: {
    entity,
    position: { x: 0, y: 0, z: 0 },
    rotation: { x: 0, y: 0, z: 0, w: 1 },
    scale: { x: 1, y: 1, z: 1 },
    visible: true,
  },
});

/**
 * @param entity Entity id.
 * @returns The guest's `add-body` for it, a box.
 */
const addBox = (entity: number): Command => ({
  tag: 'add-body',
  val: {
    body: 5,
    entity,
    kind: 'fixed',
    shape: { kind: 'box', halfExtents: { x: 1, y: 2, z: 3 } },
    position: { x: 0, y: 0, z: 0 },
    rotation: { x: 0, y: 0, z: 0, w: 1 },
    mass: 0,
    friction: 0.5,
    restitution: 0,
    linearDamping: 0,
    angularDamping: 0,
    layer: {},
    mask: {},
    flags: {},
  },
});

describe('Replicator: a body with no asset introduces its shape', () => {
  it('spawn, then the shape, then the tint: the box lands before the material param', () => {
    const { replicator, step } = world();
    replicator.add(1);
    step([
      spawnNoAsset(20),
      addBox(20),
      { tag: 'set-material-param', val: { entity: 20, name: 'tint', value: { tag: 'scalar', val: 1 } } },
    ]);
    const commands = replicator.viewFor(1).commands;
    expect(tags(commands)).toEqual(['spawn', 'add-body', 'set-material-param']);
    const shape = commands[1];
    expect(shape).toMatchObject({
      tag: 'add-body',
      val: { entity: 20, shape: { kind: 'box', halfExtents: { x: 1, y: 2, z: 3 } } },
    });
  });

  it('an entity with an asset gets no shape command', () => {
    const { replicator, step } = world();
    replicator.add(1);
    step([
      {
        tag: 'spawn',
        val: {
          entity: 21,
          asset: 7,
          position: { x: 0, y: 0, z: 0 },
          rotation: { x: 0, y: 0, z: 0, w: 1 },
          scale: { x: 1, y: 1, z: 1 },
          visible: true,
        },
      },
      addBox(21),
    ]);
    expect(tags(replicator.viewFor(1).commands)).toEqual(['spawn']);
  });
});
