import { describe, expect, it } from 'vitest';
import type { PhysicsService } from '@gameable/physics-jolt';
import type { CameraState, Command, FrameOutput } from '@gameable/sdk';

import { applyOutput } from '../apply';
import { createServerAdapter } from './createServerAdapter';

/** @returns A physics stand-in that accepts every call. */
function fakePhysics(): PhysicsService {
  const nothing = (): void => undefined;
  return {
    addBody: nothing,
    removeBody: nothing,
    setTransform: nothing,
    setVelocity: nothing,
    applyImpulse: nothing,
    setEnabled: nothing,
    moveCharacter: nothing,
    groundState: () => 'on-ground',
  } as never;
}

const CAMERA: CameraState = {
  mode: 'first-person',
  projection: 'perspective',
  position: { x: 0, y: 0, z: 0 },
  rotation: { x: 0, y: 0, z: 0, w: 1 },
  target: undefined,
  fovYDeg: 75,
  near: 0.1,
  far: 1000,
  follow: undefined,
  armLength: 0,
  offset: { x: 0, y: 0, z: 0 },
};

/**
 * @param commands The shared commands.
 * @param localCommands The authority's own.
 * @returns A frame output.
 */
const out = (commands: Command[], localCommands: Command[] = []): FrameOutput => ({
  transforms: new Float32Array(12),
  localCommands,
  commands,
  camera: CAMERA,
  hud: undefined,
});

const spawn = (entity: number): Command => ({
  tag: 'spawn',
  val: {
    entity,
    asset: 7,
    position: { x: 0, y: 0, z: 0 },
    rotation: { x: 0, y: 0, z: 0, w: 1 },
    scale: { x: 1, y: 1, z: 1 },
    visible: true,
  },
});

const state = (entity: number, vx: number): Command => ({
  tag: 'set-character-state',
  val: { entity, state: 'walk', velocity: { x: vx, y: 0, z: 0 }, grounded: true },
});

describe('ServerAdapter: local commands stay on the authority', () => {
  it('a spawn in localCommands makes a record marked localOnly', () => {
    const a = createServerAdapter(fakePhysics());
    a.beginTick();
    applyOutput(a, out([spawn(5)], [spawn(6)]));
    expect(a.world.get(5)?.localOnly).toBe(false);
    expect(a.world.get(6)?.localOnly).toBe(true);
  });

  it('a local change to a shared entity does not touch its record', () => {
    const a = createServerAdapter(fakePhysics());
    a.beginTick();
    applyOutput(a, out([spawn(5)]));
    const before = a.world.get(5)?.serial;
    a.beginTick();
    applyOutput(a, out([], [
      { tag: 'set-material-param', val: { entity: 5, name: 'tint', value: { tag: 'scalar', val: 1 } } },
      { tag: 'set-asset', val: { entity: 5, asset: 9 } },
      { tag: 'despawn', val: 5 },
    ]));
    const record = a.world.get(5);
    expect(record?.asset).toBe(7);
    expect(record?.visual.materials).toHaveLength(0);
    expect(record?.serial).toBe(before);
  });

  it('local one-shots, sends and per-player views go nowhere', () => {
    const a = createServerAdapter(fakePhysics());
    a.beginTick();
    applyOutput(a, out([], [
      { tag: 'say', val: { entity: 5, text: 'secret' } },
      { tag: 'send', val: { to: 1, name: 'role', payload: '{}', reliable: true } },
      { tag: 'send', val: { name: 'all', payload: '{}', reliable: true } },
      { tag: 'set-player-hud', val: { player: 1, hud: '{"x":1}' } },
    ]));
    expect(a.transient).toEqual([]);
    expect(a.sends).toEqual([]);
    expect(a.broadcasts).toEqual([]);
    expect(a.perPlayer[1]?.hud).toBeUndefined();
  });

  it('commands after the local span apply again', () => {
    const a = createServerAdapter(fakePhysics());
    a.beginTick();
    applyOutput(a, out([], [spawn(6)]));
    a.beginTick();
    applyOutput(a, out([spawn(7)]));
    expect(a.world.get(7)?.localOnly).toBe(false);
  });
});

describe('ServerAdapter: character velocity', () => {
  it('records the velocity and moves characterSerial on a velocity-only change', () => {
    const a = createServerAdapter(fakePhysics());
    a.beginTick();
    applyOutput(a, out([spawn(5), state(5, 3)]));
    expect(a.world.get(5)?.character?.velocity).toEqual({ x: 3, y: 0, z: 0 });
    a.beginTick();
    applyOutput(a, out([state(5, 6)]));
    const record = a.world.get(5);
    expect(record?.characterSerial).toBe(a.world.frame);
    expect(record?.character?.velocity.x).toBe(6);
  });

  it('a velocity within the tolerance is no change', () => {
    const a = createServerAdapter(fakePhysics());
    a.beginTick();
    applyOutput(a, out([spawn(5), state(5, 3)]));
    const first = a.world.frame;
    a.beginTick();
    applyOutput(a, out([state(5, 3.01)]));
    expect(a.world.get(5)?.characterSerial).toBe(first);
    expect(a.world.get(5)?.character?.velocity.x).toBe(3);
  });

  it('the snapshot copies the velocity rather than aliasing it', () => {
    const a = createServerAdapter(fakePhysics());
    a.beginTick();
    applyOutput(a, out([spawn(5), state(5, 3)]));
    const snap = a.world.snapshot().entities[0];
    a.beginTick();
    applyOutput(a, out([state(5, 6)]));
    expect(snap.character?.velocity.x).toBe(3);
  });
});

describe('ServerAdapter: one ordered send log', () => {
  it('keeps broadcasts and private sends in the order the guest sent them', () => {
    const a = createServerAdapter(fakePhysics());
    a.beginTick();
    applyOutput(a, out([
      { tag: 'send', val: { name: 'round-start', payload: '{}', reliable: true } },
      { tag: 'send', val: { to: 2, name: 'your-role', payload: '{}', reliable: true } },
    ]));
    expect(a.sends.map((s) => [s.to, s.name])).toEqual([
      [undefined, 'round-start'],
      [2, 'your-role'],
    ]);
    a.beginTick();
    expect(a.sends).toEqual([]);
  });
});
