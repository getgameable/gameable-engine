/// <reference types="node" />
/**
 * Body ids are the guest's choice, so no allocation may depend on one (3.8
 * review I5): an `add-body` at or past `maxBodies` is dropped with one
 * warning, never mapped and never sent to Jolt.
 */
import type { PhysicsService } from '@gameable/physics-jolt';
import type { AddBodyCmd, CameraState, Command, FrameOutput } from '@gameable/sdk';
import { describe, expect, it } from 'vitest';

import { applyOutput } from '../apply';
import { createServerAdapter } from './createServerAdapter';

/** @returns A physics stand-in recording the bodies it was given. */
function fakePhysics(): PhysicsService & { added: number[] } {
  const added: number[] = [];
  const nothing = (): void => undefined;
  return {
    added,
    addBody: (body: { id: number }) => {
      added.push(body.id);
    },
    removeBody: nothing,
    setTransform: nothing,
    setVelocity: nothing,
    applyImpulse: nothing,
    setEnabled: nothing,
    moveCharacter: nothing,
    groundState: () => 'on-ground',
  } as never;
}

const spawn = (entity: number): Command => ({
  tag: 'spawn',
  val: {
    entity,
    asset: 7,
    position: { x: 0, y: 0, z: 0 },
    rotation: { x: 0, y: 0, z: 0, w: 1 },
    scale: { x: 1, y: 1, z: 1 },
    parent: undefined,
    visible: true,
    name: 'crate',
  },
});

const addBody = (body: number, entity: number): Command => ({
  tag: 'add-body',
  val: {
    body,
    entity,
    kind: 'dynamic',
    shape: { kind: 'box', halfExtents: { x: 0.5, y: 0.5, z: 0.5 }, asset: undefined },
    position: { x: 0, y: 1, z: 0 },
    rotation: { x: 0, y: 0, z: 0, w: 1 },
    mass: 1,
    friction: 0.5,
    restitution: 0,
    linearDamping: 0.05,
    angularDamping: 0.05,
    layer: { defaultLayer: true },
    mask: { defaultLayer: true },
    flags: {},
  } satisfies AddBodyCmd,
});

/** A whole camera; the adapter copies every field of it. */
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

const out = (commands: Command[]): FrameOutput => ({
  transforms: new Float32Array(0),
  localCommands: [],
  commands,
  camera: CAMERA,
  hud: undefined,
});

describe('createServerAdapter: guest body ids', () => {
  it('drops an add-body past maxBodies with one warning, and allocates nothing for it', () => {
    const warnings: string[] = [];
    const physics = fakePhysics();
    const adapter = createServerAdapter(physics, { maxBodies: 1024, warn: (m) => warnings.push(m) });
    adapter.beginTick();
    const before = process.memoryUsage().arrayBuffers;
    applyOutput(adapter, out([spawn(5), addBody(0xffffffff, 5), addBody(1025, 5), addBody(1024, 5)]));
    const grown = process.memoryUsage().arrayBuffers - before;
    expect(grown).toBeLessThan(1 << 20); // the old table grew to 2^32 slots (16 GB, lazily)
    expect(physics.added).toEqual([1024]); // maxBodies 1024 holds id 1024
    expect(adapter.world.entityOfBody(0xffffffff)).toBe(0);
    expect(adapter.world.entityOfBody(1025)).toBe(0);
    expect(adapter.world.entityOfBody(1024)).toBe(5);
    expect(adapter.world.entities.get(5)?.body).toBe(1024);
    expect(warnings.filter((w) => w.includes('maxBodies'))).toHaveLength(1);
  });
});
