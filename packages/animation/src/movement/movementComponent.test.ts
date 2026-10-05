// Ported from aos-threejs-poc/tests/unit/movementComponent.test.mjs @ cdd63b10
import { describe, expect, it } from 'vitest';

import {
  createMovementComponent,
  type MoveCompletedEvent,
  type MovementGroupLike,
  type NavMeshLike,
  type Vec3,
} from './movementComponent';

/**
 * A navmesh with no obstacles: every goal is one straight segment away.
 *
 * @returns The navmesh.
 */
function openNavMesh(): NavMeshLike {
  return {
    floorY: 0,
    findPath(_from: Vec3, to: Vec3): Vec3[] {
      return [[to[0], to[1], to[2]]];
    },
    getRandomReachablePoint(center: Vec3, radius: number): Vec3 {
      return [center[0] + radius, center[1], center[2]];
    },
  };
}

/**
 * A fake transform, as the POC's test used: no three involved.
 *
 * @returns The transform.
 */
function fakeGroup(): MovementGroupLike {
  return { position: { x: 0, y: 0, z: 0 }, rotation: { y: 0 } };
}

/**
 * Wire up a component with an open navmesh and an event log.
 *
 * @returns The component, its transform and the events it fired.
 */
function setup(): {
  movement: ReturnType<typeof createMovementComponent>;
  group: MovementGroupLike;
  events: { type: string; data: MoveCompletedEvent }[];
} {
  const movement = createMovementComponent();
  const events: { type: string; data: MoveCompletedEvent }[] = [];
  const group = fakeGroup();
  movement.setNavMesh(openNavMesh());
  movement.setGroup(group);
  movement.setEventSink((type, data) => events.push({ type, data }));
  movement.configure({ maxSpeed: 2, accel: 100, acceptanceRadius: 0.2, turnRate: 100 });
  return { movement, group, events };
}

describe('MovementComponent', () => {
  it('walks the transform to the target and reports success', () => {
    const { movement, group, events } = setup();
    expect(movement.moveToLocation([8, 0, 0])).toBe(true);
    expect(movement.status).toBe('moving');
    for (let i = 0; i < 2000 && movement.status === 'moving'; i += 1) movement.tick(1 / 60);
    expect(movement.status).toBe('arrived');
    expect(Math.hypot(group.position.x - 8, group.position.z)).toBeLessThanOrEqual(0.21);
    const done = events.filter((e) => e.type === 'onMoveCompleted');
    expect(done).toHaveLength(1);
    expect(done[0].data.result).toBe('success');
  });

  it('does not teleport onto the goal inside the acceptance radius', () => {
    const { movement, group } = setup();
    movement.configure({ acceptanceRadius: 1 });
    movement.moveToLocation([8, 0, 0]);
    for (let i = 0; i < 2000 && movement.status === 'moving'; i += 1) movement.tick(1 / 60);
    expect(group.position.x).toBeLessThan(8);
  });

  it('aborting mid-move stops it and fires aborted', () => {
    const { movement, events } = setup();
    movement.moveToLocation([8, 0, 8]);
    movement.tick(1 / 60);
    expect(movement.status).toBe('moving');
    movement.abort();
    expect(movement.status).toBe('idle');
    expect(events.filter((e) => e.data.result === 'aborted')).toHaveLength(1);
    movement.tick(1 / 60);
    expect(movement.status).toBe('idle');
  });

  it('a new moveTo replaces the active path', () => {
    const { movement } = setup();
    movement.moveToLocation([8, 0, 0]);
    movement.tick(1 / 60);
    movement.targetIndex = 5;
    movement.moveToLocation([0, 0, 8]);
    expect(movement.targetIndex).toBe(0);
    expect(movement.status).toBe('moving');
  });

  it('faces the direction of travel', () => {
    const { movement, group } = setup();
    movement.moveToLocation([8, 0, 0]);
    for (let i = 0; i < 60 && movement.status === 'moving'; i += 1) movement.tick(1 / 60);
    expect(group.rotation.y).toBeCloseTo(Math.PI / 2, 3);
  });

  it('fails loudly with no navmesh', () => {
    const movement = createMovementComponent();
    const events: MoveCompletedEvent[] = [];
    movement.setGroup(fakeGroup());
    movement.setEventSink((_type, data) => events.push(data));
    expect(movement.moveToLocation([1, 0, 1])).toBe(false);
    expect(movement.status).toBe('failed');
    expect(events[0].reason).toMatch(/no navmesh/);
  });

  it('follows a moving target and re-paths when it drifts', () => {
    const { movement } = setup();
    const target = { position: { x: 4, y: 0, z: 0 } };
    expect(movement.moveToActor(target)).toBe(true);
    movement.tick(1 / 60);
    target.position.x = 20;
    movement.tick(1 / 60);
    expect(movement.status).toBe('moving');
    expect(movement.path[0][0]).toBe(20);
  });

  it('gives every character its own component, with no shared singleton', () => {
    const a = createMovementComponent({ config: { maxSpeed: 1 } });
    const b = createMovementComponent({ config: { maxSpeed: 9 } });
    expect(a.config.maxSpeed).toBe(1);
    expect(b.config.maxSpeed).toBe(9);
  });
});
