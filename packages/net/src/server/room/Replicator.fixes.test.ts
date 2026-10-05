/**
 * Fix round 1 of task 3.6b: local commands, character velocity, message
 * order, and a relevancy origin that follows the player's current entity.
 */
import { describe, expect, it } from 'vitest';
import type { CameraState, Command } from '@gameable/sdk';

import { CAMERA, possess, spawn, tags, world } from './replicatorTesting.js';

const camera = (patch: Partial<CameraState>): CameraState => ({ ...CAMERA, ...patch });
const spawnIds = (commands: readonly Command[]): number[] =>
  commands.flatMap((c) => (c.tag === 'spawn' ? [c.val.entity] : []));

describe('Replicator: local commands (I1)', () => {
  it('a spawn in localCommands reaches nobody: not the views, not the welcome', () => {
    const { replicator, step } = world();
    replicator.add(1);
    step([spawn(5)], [], [spawn(77), { tag: 'say', val: { entity: 5, text: 'psst' } }]);
    expect(spawnIds(replicator.viewFor(1).commands)).toEqual([5]);
    expect(tags(replicator.viewFor(1).commands)).not.toContain('say');
    replicator.add(2);
    const welcome = JSON.parse(replicator.snapshotFor(2)) as { entities: { entity: number }[] };
    expect(welcome.entities.map((e) => e.entity)).toEqual([5]);
    step();
    expect(replicator.viewFor(2).commands).toEqual([]);
  });

  it('a local change to a shared entity sends nothing', () => {
    const { replicator, step } = world();
    replicator.add(1);
    step([spawn(5)]);
    replicator.viewFor(1);
    step([], [], [{ tag: 'set-material-param', val: { entity: 5, name: 'murderer', value: { tag: 'boolean', val: true } } }]);
    expect(replicator.viewFor(1).commands).toEqual([]);
  });
});

describe('Replicator: character velocity (I2)', () => {
  it('replicates the velocity, and a velocity-only change', () => {
    const { replicator, step } = world();
    replicator.add(1);
    const walk = (vx: number): Command => ({
      tag: 'set-character-state',
      val: { entity: 5, state: 'walk', velocity: { x: vx, y: 0, z: 0 }, grounded: true },
    });
    step([spawn(5), walk(3)]);
    const intro = replicator.viewFor(1).commands.find((c) => c.tag === 'set-character-state');
    expect(intro).toMatchObject({ val: { velocity: { x: 3, y: 0, z: 0 } } });
    step([walk(6)]);
    expect(replicator.viewFor(1).commands).toEqual([
      { tag: 'set-character-state', val: { entity: 5, state: 'walk', velocity: { x: 6, y: 0, z: 0 }, grounded: true } },
    ]);
  });
});

describe('Replicator: message order (I3)', () => {
  it('a broadcast round-start then a private your-role arrive in that order', () => {
    const { replicator, step } = world();
    replicator.add(1);
    replicator.add(2);
    step([
      { tag: 'send', val: { name: 'round-start', payload: '{}', reliable: true } },
      { tag: 'send', val: { to: 2, name: 'your-role', payload: '"murderer"', reliable: true } },
      { tag: 'send', val: { name: 'clock', payload: '1', reliable: true } },
    ]);
    expect(replicator.viewFor(2).messages.map((m) => m.name)).toEqual(['round-start', 'your-role', 'clock']);
    expect(replicator.viewFor(1).messages.map((m) => m.name)).toEqual(['round-start', 'clock']);
  });
});

describe('Replicator: the relevancy origin follows the current entity (I5, as ruled in round 2)', () => {
  it('follows possess across a respawn', () => {
    const { replicator, step } = world({ cullDistance: 10 });
    step([spawn(20), spawn(30, { x: 100 })]);
    replicator.add(1);
    step([possess(1, 20)]);
    expect(spawnIds(replicator.viewFor(1).commands)).toEqual([20]);
    // Death and respawn far away: the old entity goes, the player possesses the new one.
    step([{ tag: 'despawn', val: 20 }, spawn(40, { x: 101 }), possess(1, 40)]);
    expect(replicator.entityOf(1)).toBe(40);
    const after = replicator.viewFor(1).commands;
    expect(spawnIds(after).sort()).toEqual([30, 40]);
  });

  it('falls back to the camera position when the player controls nothing', () => {
    const { replicator, step } = world({ cullDistance: 10 });
    step([spawn(20), spawn(30, { x: 100 })]);
    replicator.add(1);
    step([{ tag: 'set-player-camera', val: { player: 1, camera: camera({ position: { x: 99, y: 0, z: 0 } }) } }]);
    expect(spawnIds(replicator.viewFor(1).commands)).toEqual([30]);
  });

  it('judges a parented player entity by its world position, not its local one', () => {
    const { replicator, step } = world({ cullDistance: 10 });
    step([spawn(22, { x: 100 }), spawn(21, { x: 1, parent: 22 }), spawn(50)]);
    replicator.add(1);
    step([possess(1, 21)]);
    // The seat is at x = 101: entity 50 at the origin is out of range, the vehicle is in.
    expect(spawnIds(replicator.viewFor(1).commands)).toEqual([22, 21]);
  });
});

describe('Replicator: a late joiner sees what an early joiner built (M5)', () => {
  it("the welcome equals the early joiner's accumulated view of the same world", () => {
    const { replicator, step } = world();
    replicator.add(0);
    const model = new Map<number, Record<string, unknown>>();
    const apply = (commands: readonly Command[]): void => {
      for (const c of commands) {
        if (c.tag === 'spawn') model.set(c.val.entity, { asset: c.val.asset, parent: c.val.parent, anim: null, character: null });
        else if (c.tag === 'despawn') model.delete(c.val);
        else if (c.tag === 'set-asset') Object.assign(model.get(c.val.entity) ?? {}, { asset: c.val.asset });
        else if (c.tag === 'set-parent') Object.assign(model.get(c.val.entity) ?? {}, { parent: c.val.parent });
        else if (c.tag === 'set-anim') Object.assign(model.get(c.val.entity) ?? {}, { anim: c.val.clip });
        else if (c.tag === 'set-character-state')
          Object.assign(model.get(c.val.entity) ?? {}, { character: [c.val.state, c.val.velocity.x] });
        else if (c.tag === 'set-expression')
          Object.assign(model.get(c.val.entity) ?? {}, { expression: Array.from(c.val.weights) });
      }
    };
    const script: Command[][] = [
      [spawn(1), spawn(2), spawn(3)],
      [{ tag: 'set-parent', val: { entity: 3, parent: 1, keepWorldTransform: false } }],
      [{ tag: 'set-anim', val: { entity: 1, clip: 'run', looping: true, speed: 1, fadeMs: 0, weight: 1 } }],
      [{ tag: 'set-asset', val: { entity: 1, asset: 9 } }, { tag: 'despawn', val: 2 }],
      [
        { tag: 'set-character-state', val: { entity: 1, state: 'walk', velocity: { x: 2, y: 0, z: 0 }, grounded: true } },
        { tag: 'set-expression', val: { entity: 3, space: 'arkit52', weights: [0.5] } },
        spawn(4, { parent: 3 }),
      ],
    ];
    for (const commands of script) {
      step(commands);
      apply(replicator.viewFor(0).commands);
    }
    replicator.add(1);
    const welcome = JSON.parse(replicator.snapshotFor(1)) as {
      entities: {
        entity: number;
        asset?: number;
        parent?: number;
        anim: { clip: string } | null;
        character: { state: string; velocity: { x: number } } | null;
        visual: { expressions: { weights: number[] }[] };
      }[];
    };
    const late = new Map<number, Record<string, unknown>>();
    for (const e of welcome.entities) {
      const row: Record<string, unknown> = {
        asset: e.asset,
        parent: e.parent,
        anim: e.anim?.clip ?? null,
        character: e.character === null ? null : [e.character.state, e.character.velocity.x],
      };
      if (e.visual.expressions.length > 0) row.expression = e.visual.expressions[0].weights;
      late.set(e.entity, row);
    }
    expect([...late.keys()].sort()).toEqual([...model.keys()].sort());
    for (const [id, row] of model) expect(late.get(id)).toEqual(row);
  });
});
