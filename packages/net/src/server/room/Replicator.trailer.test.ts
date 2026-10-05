/**
 * Task 8.1 on the server: each player's rows carry their own body (the
 * trailer), read from the physics world after the step; none for a
 * spectator.
 */
import type { PhysicsService } from '@gameable/physics-jolt';
import type { Command, FrameOutput } from '@gameable/sdk';
import { applyOutput, createServerAdapter } from '@gameable/wasm-host/server';
import { describe, expect, it } from 'vitest';

import { PlayerRowFlag } from '../../protocol/constants.js';
import { Replicator } from './Replicator.js';
import { CAMERA, fakePhysics, possess, spawn, transforms } from './replicatorTesting.js';

/** One stride-15 body row: id, position, rotation, linear and angular velocity, ground state. */
type BodyRow = [
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
];

/** @returns A physics stand-in whose post-step rows the test sets. */
function physicsWith(): PhysicsService & { rows: BodyRow[]; reads: number } {
  const physics = Object.assign(fakePhysics(), { rows: [] as BodyRow[], reads: 0 });
  Object.defineProperty(physics, 'movingBodyCount', { get: () => physics.rows.length });
  physics.readBodies = (out: Float32Array): number => {
    physics.reads += 1;
    physics.rows.forEach((row, i) => {
      out.set(row, i * 15);
    });
    return physics.rows.length;
  };
  return physics;
}

const addCharacter = (body: number, entity: number): Command => ({
  tag: 'add-body',
  val: {
    body,
    entity,
    kind: 'character',
    shape: { kind: 'capsule', halfExtents: { x: 0.3, y: 0.9, z: 0.3 }, asset: undefined },
    position: { x: 0, y: 1, z: 0 },
    rotation: { x: 0, y: 0, z: 0, w: 1 },
    mass: 80,
    friction: 0.5,
    restitution: 0,
    linearDamping: 0,
    angularDamping: 0,
    layer: {},
    mask: {},
    flags: {},
  },
});

/** @returns A replicator over a real server adapter, and one step. */
function room(): {
  physics: ReturnType<typeof physicsWith>;
  replicator: Replicator;
  step: (commands?: Command[], teleport?: boolean) => void;
} {
  const physics = physicsWith();
  const adapter = createServerAdapter(physics, { warn: () => undefined });
  const replicator = new Replicator(adapter, {}, physics);
  const step = (commands: Command[] = []): void => {
    adapter.beginTick();
    const out: FrameOutput = {
      transforms: transforms([]),
      localCommands: [],
      commands,
      camera: CAMERA,
      hud: undefined,
    };
    applyOutput(adapter, out);
    adapter.applyBodyRows(new Float32Array(physics.rows.flat()), physics.rows.length);
    replicator.collect();
  };
  return { physics, replicator, step };
}

describe('Replicator: the player trailer', () => {
  it("carries the player's own body: position, velocity and grounded from the post-step rows", () => {
    const { physics, replicator, step } = room();
    replicator.add(0);
    physics.rows = [[3, 1, 2, 3, 0, 0, 0, 1, 4, -1, 0.5, 0, 0, 0, 1]];
    step([spawn(5), addCharacter(3, 5), possess(0, 5)]);
    const rows = replicator.viewFor(0).takeRows();
    const player = rows.player;
    expect(player?.entity).toBe(5);
    expect(Array.from(player?.position ?? [])).toEqual([1, 2, 3]);
    expect(Array.from(player?.velocity ?? [])).toEqual([4, -1, 0.5]);
    expect(player?.flags).toBe(PlayerRowFlag.GROUNDED);
    physics.rows = [[3, 1, 5, 3, 0, 0, 0, 1, 0, 2, 0, 0, 0, 0, 4]];
    step();
    expect(replicator.viewFor(0).takeRows().player?.flags).toBe(0); // in the air now
  });

  it('is absent for a spectator, and for an entity that has no body', () => {
    const { physics, replicator, step } = room();
    replicator.add(0);
    replicator.add(1);
    physics.rows = [[3, 1, 2, 3, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 1]];
    step([spawn(5), spawn(6), addCharacter(3, 5), possess(1, 6)]);
    expect(replicator.viewFor(0).takeRows().player ?? null).toBeNull(); // no entity: spectating
    expect(replicator.viewFor(1).takeRows().player ?? null).toBeNull(); // an entity, but no body
  });

  it('says TELEPORT once, on the first rows after the authority teleported the body', () => {
    const { physics, replicator, step } = room();
    replicator.add(0);
    physics.rows = [[3, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 1]];
    step([spawn(5), addCharacter(3, 5), possess(0, 5)]);
    replicator.viewFor(0).takeRows();
    physics.rows = [[3, 40, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 1]];
    const warp: Command = {
      tag: 'set-body-transform',
      val: {
        body: 3,
        position: { x: 40, y: 1, z: 0 },
        rotation: { x: 0, y: 0, z: 0, w: 1 },
        teleport: true,
      },
    };
    step([warp]);
    const first = replicator.viewFor(0).takeRows().player?.flags ?? 0;
    expect(first & PlayerRowFlag.TELEPORT).toBe(PlayerRowFlag.TELEPORT);
    step();
    expect((replicator.viewFor(0).takeRows().player?.flags ?? 0) & PlayerRowFlag.TELEPORT).toBe(0);
  });

  it('reads the physics world at most once per step, however many players take rows', () => {
    const { physics, replicator, step } = room();
    for (let p = 0; p < 4; p += 1) replicator.add(p);
    physics.rows = [[3, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 1]];
    step([spawn(5), addCharacter(3, 5), possess(0, 5), possess(1, 5), possess(2, 5)]);
    for (let p = 0; p < 4; p += 1) replicator.viewFor(p).takeRows();
    expect(physics.reads).toBe(1);
  });
});
