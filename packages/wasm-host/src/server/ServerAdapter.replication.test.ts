import { describe, expect, it } from 'vitest';
import type { PhysicsService } from '@gameable/physics-jolt';
import { TRANSFORM_FLAGS } from '@gameable/sdk';
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

const out = (commands: Command[], transforms = new Float32Array(12)): FrameOutput => ({
  transforms,
  localCommands: [],
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

const addBody = (body: number, entity: number): Command => ({
  tag: 'add-body',
  val: {
    body,
    entity,
    kind: 'dynamic',
    shape: { kind: 'box', halfExtents: { x: 0.5, y: 0.5, z: 0.5 } },
    position: { x: 0, y: 0, z: 0 },
    rotation: { x: 0, y: 0, z: 0, w: 1 },
    mass: 1,
    friction: 0.5,
    restitution: 0,
    linearDamping: 0,
    angularDamping: 0,
    layer: { defaultLayer: true },
    mask: { defaultLayer: true },
    flags: {},
  },
});

const VISUAL: Command[] = [
  { tag: 'set-material-param', val: { entity: 5, name: 'tint', value: { tag: 'scalar', val: 1 } } },
  { tag: 'set-expression', val: { entity: 5, space: 'arkit52', weights: [0.5] } },
  { tag: 'look-at', val: { entity: 5, target: { x: 0, y: 1, z: 0 }, weight: 1 } },
  { tag: 'set-clip-weights', val: { entity: 5, clips: ['idle'], weights: [1], timeScale: 1 } },
];

const TRANSIENT: Command[] = [
  { tag: 'say', val: { entity: 5, text: 'hi' } },
  {
    tag: 'play-sound',
    val: { sound: 1, asset: 2, volume: 1, pitch: 1, looping: false, bus: 'sfx' },
  },
  { tag: 'stop-sound', val: { sound: 1, fadeMs: 0 } },
  {
    tag: 'set-listener',
    val: {
      position: { x: 0, y: 0, z: 0 },
      rotation: { x: 0, y: 0, z: 0, w: 1 },
      velocity: { x: 0, y: 0, z: 0 },
    },
  },
  { tag: 'load-asset', val: { asset: 3, priority: 0 } },
];

describe('ServerAdapter: what changed this tick', () => {
  it('routes the five per-tick events to transient and the four visual ones to the record', () => {
    const a = createServerAdapter(fakePhysics());
    a.beginTick();
    applyOutput(a, out([spawn(5), ...VISUAL, ...TRANSIENT]));
    expect(a.transient.map((c) => c.tag)).toEqual([
      'say',
      'play-sound',
      'stop-sound',
      'set-listener',
      'load-asset',
    ]);
    const visual = a.world.get(5)?.visual;
    expect(visual?.materials).toHaveLength(1);
    expect(visual?.expressions).toHaveLength(1);
    expect(visual?.lookAt?.weight).toBe(1);
    expect(visual?.clipWeights?.clips).toEqual(['idle']);
    expect(visual?.serial).toBe(a.world.frame);
  });

  it('the same visual state sent again next tick changes nothing', () => {
    const a = createServerAdapter(fakePhysics());
    a.beginTick();
    applyOutput(a, out([spawn(5), ...VISUAL]));
    const first = a.world.frame;
    a.beginTick();
    applyOutput(a, out(VISUAL));
    expect(a.world.get(5)?.serial).toBe(first);
    expect(a.world.get(5)?.visual.serial).toBe(first);
  });

  it('set-body-transform with teleport marks the entity it drives', () => {
    const a = createServerAdapter(fakePhysics());
    a.beginTick();
    applyOutput(a, out([spawn(5), addBody(11, 5)]));
    a.beginTick();
    const move = (teleport: boolean): Command => ({
      tag: 'set-body-transform',
      val: {
        body: 11,
        position: { x: 1, y: 0, z: 0 },
        rotation: { x: 0, y: 0, z: 0, w: 1 },
        teleport,
      },
    });
    applyOutput(a, out([move(false)]));
    expect(a.world.get(5)?.teleportedAt).toBe(-1);
    applyOutput(a, out([move(true)]));
    expect(a.world.get(5)?.teleportedAt).toBe(a.world.frame);
  });

  it('a transform row with the teleport flag marks the entity', () => {
    const a = createServerAdapter(fakePhysics());
    a.beginTick();
    applyOutput(a, out([spawn(5)]));
    a.beginTick();
    const flags = TRANSFORM_FLAGS.POSITION | TRANSFORM_FLAGS.TELEPORT;
    applyOutput(a, out([], new Float32Array([5, flags, 9, 9, 9, 0, 0, 0, 1, 1, 1, 1])));
    const rec = a.world.get(5);
    expect(rec?.teleportedAt).toBe(a.world.frame);
    expect(rec?.serial).toBe(a.world.frame);
    a.beginTick();
    applyOutput(a, out([], new Float32Array([5, 1, 8, 8, 8, 0, 0, 0, 1, 1, 1, 1])));
    expect(rec?.teleportedAt).toBe(a.world.frame - 1);
  });

  it('the guest rotation tick lives on the record', () => {
    const a = createServerAdapter(fakePhysics());
    a.beginTick();
    applyOutput(a, out([spawn(5)]));
    expect(a.world.get(5)?.authoredAt).toBe(-1);
    a.beginTick();
    applyOutput(a, out([], new Float32Array([5, 2, 0, 0, 0, 0, 1, 0, 0, 1, 1, 1])));
    expect(a.world.get(5)?.authoredAt).toBe(a.world.frame);
  });

  it('beginTick empties the spawn and despawn logs', () => {
    const a = createServerAdapter(fakePhysics());
    a.beginTick();
    applyOutput(a, out([spawn(5), spawn(6)]));
    expect(a.world.spawned).toEqual([5, 6]);
    a.beginTick();
    applyOutput(a, out([{ tag: 'despawn', val: 6 }]));
    expect(a.world.spawned).toEqual([]);
    expect(a.world.despawned).toEqual([6]);
    a.beginTick();
    expect(a.world.despawned).toEqual([]);
  });

  it('a transform row moves the pose tick only; a VISIBLE row the state tick', () => {
    const a = createServerAdapter(fakePhysics());
    a.beginTick();
    applyOutput(
      a,
      out([{ ...spawn(5), val: { ...(spawn(5).val as object), visible: false } } as Command]),
    );
    const born = a.world.frame;
    a.beginTick();
    applyOutput(a, out([], new Float32Array([5, 1, 9, 9, 9, 0, 0, 0, 1, 1, 1, 1])));
    const rec = a.world.get(5)!;
    const now = a.world.frame;
    expect([rec.poseSerial, rec.stateSerial, rec.animSerial, rec.characterSerial]).toEqual([
      now,
      born,
      born,
      born,
    ]);
    expect(rec.serial).toBe(now);
    a.beginTick();
    applyOutput(
      a,
      out([], new Float32Array([5, TRANSFORM_FLAGS.VISIBLE, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1])),
    );
    expect(rec.visible).toBe(true);
    expect(rec.stateSerial).toBe(a.world.frame);
    expect(rec.poseSerial).toBe(now);
  });

  it('a body row moves the pose tick only', () => {
    const a = createServerAdapter(fakePhysics());
    a.beginTick();
    applyOutput(a, out([spawn(5), addBody(11, 5)]));
    const born = a.world.frame;
    a.beginTick();
    a.applyBodyRows(new Float32Array([11, 3, 3, 3, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 1]), 1);
    const rec = a.world.get(5)!;
    expect(rec.poseSerial).toBe(a.world.frame);
    expect(rec.stateSerial).toBe(born);
  });
});
