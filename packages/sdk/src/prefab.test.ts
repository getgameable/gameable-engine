import { beforeEach, describe, expect, it } from 'vitest';

import { defineGame } from './defineGame';
import { Character, Enemy, Health, RigidBody, Transform, hasComponent } from './ecs';
import { prefab, resetPrefabRegistry } from './prefab';
import { createGuest } from './runtime';
import { createStubHost, stubConfig, stubFrame } from './testing';
import type { AddBodyCmd, Command, SpawnCmd } from './types';

/**
 * Find the first command with a tag.
 *
 * @param commands The frame's command list.
 * @param tag The tag to look for.
 * @returns The command, or undefined.
 */
function find(commands: readonly Command[], tag: Command['tag']): Command | undefined {
  return commands.find((c) => c.tag === tag);
}

describe('prefab and spawn', () => {
  beforeEach(() => {
    resetPrefabRegistry();
  });

  it('emits spawn, add-body and spawn-character on the first frame', () => {
    const Npc = prefab({
      asset: 'myra-bundle',
      name: 'npc',
      character: 'myra-bundle',
      scale: [2],
      health: 40,
      body: {
        shape: 'capsule',
        dims: [0.3, 0.9],
        kind: 'character',
        mass: 70,
        layer: { enemy: true },
        mask: { player: true },
        flags: { reportContacts: true },
        friction: 0.25,
        restitution: 0.5,
      },
      components: [Enemy],
    });
    const game = defineGame({ spawns: [{ prefab: Npc, position: [1, 2, 3] }] });
    const guest = createGuest(createStubHost(), game);
    guest.init(stubConfig());

    const out = guest.tick(stubFrame(0));
    const tags = out.commands.map((c) => c.tag);
    expect(tags).toEqual(['spawn', 'add-body', 'spawn-character']);

    const spawnCmd = find(out.commands, 'spawn')?.val as SpawnCmd;
    expect(spawnCmd.entity).toBe(1);
    expect(spawnCmd.name).toBe('npc');
    expect(spawnCmd.position).toEqual({ x: 1, y: 2, z: 3 });
    expect(spawnCmd.scale).toEqual({ x: 2, y: 2, z: 2 });
    expect(spawnCmd.visible).toBe(true);
    expect(spawnCmd.asset).toBeGreaterThan(0);

    const body = find(out.commands, 'add-body')?.val as AddBodyCmd;
    expect(body.body).toBe(1);
    expect(body.entity).toBe(1);
    expect(body.kind).toBe('character');
    expect(body.shape.kind).toBe('capsule');
    // Every float crosses as an f32, so the guest rounds on the way out.
    expect(body.shape.halfExtents.x).toBe(Math.fround(0.3));
    expect(body.shape.halfExtents.y).toBe(Math.fround(0.9));
    expect(body.shape.halfExtents.z).toBe(0.5);
    expect(body.mass).toBe(70);
    expect(body.friction).toBe(0.25);
    expect(body.restitution).toBe(0.5);

    // Flags cross with every key present, exactly as jco lifts them.
    expect(Object.keys(body.layer).length).toBe(16);
    expect(body.layer.enemy).toBe(true);
    expect(body.layer.player).toBe(false);
    expect(Object.keys(body.flags).length).toBe(6);
    expect(body.flags.reportContacts).toBe(true);
    expect(body.flags.ccd).toBe(false);
  });

  it('writes the built-in components', () => {
    const Box = prefab({ health: 7, body: { shape: 'box', kind: 'dynamic' }, components: [Enemy] });
    const game = defineGame({ spawns: [{ prefab: Box, position: [4, 5, 6] }] });
    const guest = createGuest(createStubHost(), game);
    guest.init(stubConfig());

    expect(Transform.x[1]).toBe(4);
    expect(Transform.qw[1]).toBe(1);
    expect(Transform.sx[1]).toBe(1);
    expect(RigidBody.handle[1]).toBe(1);
    expect(Health.current[1]).toBe(7);
    expect(Health.max[1]).toBe(7);
    expect(hasComponent(guest.state.world as never, 1, Enemy)).toBe(true);
    expect(hasComponent(guest.state.world as never, 1, Character)).toBe(false);
  });

  it('mints entity ids from 1 and body ids from 1', () => {
    const A = prefab({ body: { shape: 'box', kind: 'dynamic' } });
    const B = prefab({});
    const game = defineGame({
      spawns: [
        { prefab: A, position: [0, 0, 0] },
        { prefab: B, position: [0, 0, 0] },
        { prefab: A, position: [0, 0, 0] },
      ],
    });
    const guest = createGuest(createStubHost(), game);
    guest.init(stubConfig());

    expect(RigidBody.handle[1]).toBe(1);
    expect(RigidBody.handle[2]).toBe(0);
    expect(RigidBody.handle[3]).toBe(2);
  });

  it('emits despawn and remove-body together', () => {
    const Box = prefab({ body: { shape: 'box', kind: 'dynamic' } });
    const game = defineGame({
      spawns: [{ prefab: Box, position: [0, 0, 0] }],
      systems: [
        (ctx) => {
          if (ctx.frame === 1) ctx.despawn(1);
        },
      ],
    });
    const guest = createGuest(createStubHost(), game);
    guest.init(stubConfig());
    guest.tick(stubFrame(0));

    const out = guest.tick(stubFrame(1));
    expect(out.commands.map((c) => c.tag)).toEqual(['remove-body', 'despawn']);
    expect(find(out.commands, 'despawn')?.val).toBe(1);
    expect(find(out.commands, 'remove-body')?.val).toBe(1);
  });

  it('records prefabs in declaration order', () => {
    const A = prefab({});
    const B = prefab({});
    expect(A.prefabId).toBe(1);
    expect(B.prefabId).toBe(2);
  });
});
