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

describe('ServerAdapter: which entity each player controls', () => {
  it('records set-player-entity on the world, and a despawn of that entity clears it', () => {
    const a = createServerAdapter(fakePhysics());
    a.beginTick();
    applyOutput(a, out([spawn(5), spawn(6), { tag: 'set-player-entity', val: { player: 0, entity: 5 } }]));
    expect(a.world.entityOfPlayer(0)).toBe(5);
    expect(a.world.entityOfPlayer(1)).toBe(0);
    a.beginTick();
    applyOutput(a, out([{ tag: 'set-player-entity', val: { player: 0, entity: 6 } }]));
    expect(a.world.entityOfPlayer(0)).toBe(6);
    a.beginTick();
    applyOutput(a, out([{ tag: 'despawn', val: 6 }]));
    expect(a.world.entityOfPlayer(0)).toBe(0);
  });

  it('a local possess is not recorded', () => {
    const a = createServerAdapter(fakePhysics());
    a.beginTick();
    applyOutput(a, out([spawn(5)], [{ tag: 'set-player-entity', val: { player: 0, entity: 5 } }]));
    expect(a.world.entityOfPlayer(0)).toBe(0);
  });
});

describe('ServerAdapter: local mode survives a throw (R3)', () => {
  it('a command that throws inside the local span does not leave the next tick local', () => {
    const a = createServerAdapter(fakePhysics());
    a.beginTick();
    const bad = { tag: 'no-such-command', val: 0 } as unknown as Command;
    expect(() => {
      applyOutput(a, out([], [bad]));
    }).toThrow(/unhandled command/);
    a.beginTick();
    applyOutput(a, out([spawn(7)]));
    expect(a.world.get(7)?.localOnly).toBe(false);
  });
});
