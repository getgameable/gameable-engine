/**
 * Fix round 2 of task 3.6b: the guest names each player's entity
 * (`set-player-entity`), and relevancy follows it (R1).
 */
import { describe, expect, it } from 'vitest';
import type { CameraState, Command } from '@gameable/sdk';

import { CAMERA, move, spawn, world } from './replicatorTesting.js';

const possess = (player: number, entity: number): Command => ({
  tag: 'set-player-entity',
  val: { player, entity },
});
const spawnIds = (commands: readonly Command[]): number[] =>
  commands.flatMap((c) => (c.tag === 'spawn' ? [c.val.entity] : []));
const despawnIds = (commands: readonly Command[]): number[] =>
  commands.flatMap((c) => (c.tag === 'despawn' ? [c.val] : []));

describe('Replicator: the player entity is what the guest says', () => {
  it('entityOf and the view follow set-player-entity; a despawn clears them', () => {
    const { replicator, step } = world();
    replicator.add(0);
    step([spawn(5), spawn(6), possess(0, 5)]);
    expect(replicator.entityOf(0)).toBe(5);
    expect(replicator.viewFor(0).entity).toBe(5);
    step([possess(0, 6)]);
    expect(replicator.viewFor(0).entity).toBe(6);
    step([{ tag: 'despawn', val: 6 }]);
    expect(replicator.entityOf(0)).toBe(0);
    expect(replicator.viewFor(0).entity).toBe(0);
  });

  it('a camera that follows another entity (a death cam) does not change entityOf', () => {
    const { replicator, step } = world();
    replicator.add(1);
    const cam: CameraState = { ...CAMERA, follow: 6 };
    step([spawn(5), spawn(6), possess(1, 5), { tag: 'set-player-camera', val: { player: 1, camera: cam } }]);
    expect(replicator.entityOf(1)).toBe(5);
  });
});

describe('Replicator: the relevancy origin is the possessed entity (R1)', () => {
  it('player 0 walking away from a static frame camera keeps its own entity and sees what is near it', () => {
    const { replicator, step } = world({ cullDistance: 10 });
    replicator.add(0);
    step([spawn(20), spawn(30, { x: 52 }), possess(0, 20)]);
    expect(spawnIds(replicator.viewFor(0).commands)).toEqual([20]);
    for (let x = 5; x <= 50; x += 5) step([], [move(20, x)]);
    const walked = replicator.viewFor(0).commands;
    expect(despawnIds(walked)).toEqual([]);
    expect(spawnIds(walked)).toEqual([30]);
  });

  it("the player's own entity and its parent chain are always relevant", () => {
    const { replicator, step } = world({ cullDistance: 10 });
    replicator.add(1);
    // A long ship: its origin at x = 100, the seat 15 m along it.
    step([spawn(22, { x: 100 }), spawn(21, { x: 15, parent: 22 }), spawn(23, { x: 100 }), possess(1, 21)]);
    const seen = spawnIds(replicator.viewFor(1).commands);
    expect(seen).toEqual([22, 21]); // 23 sits at the ship's origin, 15 m from the seat
  });

  it("uses the player's own camera only when the player has no entity", () => {
    const { replicator, step } = world({ cullDistance: 10 });
    replicator.add(1);
    const cam: CameraState = { ...CAMERA, position: { x: 99, y: 0, z: 0 } };
    step([spawn(30, { x: 100 }), spawn(40), { tag: 'set-player-camera', val: { player: 1, camera: cam } }]);
    expect(spawnIds(replicator.viewFor(1).commands)).toEqual([30]);
    step([possess(1, 40)]);
    const after = replicator.viewFor(1).commands;
    expect(despawnIds(after)).toEqual([30]);
    expect(spawnIds(after)).toEqual([40]);
  });

  it("ignores player 0's frame camera that follows nothing (the guest never set it)", () => {
    const { replicator, step } = world({ cullDistance: 10 });
    replicator.add(0);
    step([spawn(30, { x: 100 }), spawn(31)]);
    // No entity and a default frame camera at the origin: nothing to aim at, so everything is relevant.
    expect(spawnIds(replicator.viewFor(0).commands).sort()).toEqual([30, 31]);
  });
});
