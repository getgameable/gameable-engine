import { describe, expect, it } from 'vitest';

import { BodyTable } from './BodyTable';
import { WorldRecord } from './WorldRecord';

const origin = { x: 1, y: 2, z: 3 };
const identity = { x: 0, y: 0, z: 0, w: 1 };
const unit = { x: 1, y: 1, z: 1 };

describe('WorldRecord', () => {
  it('snapshot is JSON with plain arrays and aliases nothing live', () => {
    const world = new WorldRecord();
    world.advance();
    const rec = world.spawn(5, 7, origin, identity, unit, { visible: true, name: 'crate' });
    rec.anim = { clip: 'idle', looping: true, speed: 1 };
    const snap = world.snapshot();
    rec.position[0] = 50;
    rec.anim.clip = 'run';
    expect(snap.frame).toBe(1);
    const parsed = JSON.parse(JSON.stringify(snap)) as typeof snap;
    expect(parsed.entities[0]).toMatchObject({
      entity: 5,
      asset: 7,
      position: [1, 2, 3],
      rotation: [0, 0, 0, 1],
      scale: [1, 1, 1],
      anim: { clip: 'idle' },
      name: 'crate',
      serial: 1,
    });
  });

  it('respawning an entity replaces its record and forgets its body', () => {
    const world = new WorldRecord();
    const first = world.spawn(5, 7, origin, identity, unit, { visible: true });
    world.attachBody(11, 5);
    const second = world.spawn(5, 8, origin, identity, unit, { visible: true });
    expect(second).not.toBe(first);
    expect(world.entityOfBody(11)).toBe(0);
  });

  it('despawn reports whether the entity existed', () => {
    const world = new WorldRecord();
    world.spawn(5, 7, origin, identity, unit, { visible: true });
    expect(world.despawn(5)).toBe(true);
    expect(world.despawn(5)).toBe(false);
  });
});

describe('BodyTable', () => {
  it('returns 0 for unknown, zero and out-of-range bodies', () => {
    const table = new BodyTable(4, () => undefined);
    expect(table.entityOf(0)).toBe(0);
    expect(table.entityOf(3)).toBe(0);
    expect(table.entityOf(400)).toBe(0);
  });

  it('holds ids 1 to its capacity, refuses one past it, warns once, and never grows', () => {
    const warnings: string[] = [];
    const table = new BodyTable(4, (m) => warnings.push(m));
    for (let id = 1; id <= 4; id += 1) expect(table.set(id, 10 + id)).toBe(true); // N bodies for N
    expect(table.set(5, 2)).toBe(false);
    expect(table.set(0xffffffff, 3)).toBe(false);
    expect(table.entityOf(4)).toBe(14);
    expect(table.entityOf(5)).toBe(0);
    expect(table.capacity).toBe(4);
    expect(warnings).toHaveLength(1);
  });

  it('forgetting a body past capacity does not grow the table', () => {
    const table = new BodyTable(4, () => undefined);
    table.set(100, 0);
    expect(table.capacity).toBe(4);
  });
});
