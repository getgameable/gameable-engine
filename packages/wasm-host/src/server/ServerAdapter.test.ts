import { describe, expect, it } from 'vitest';
import type { PhysicsService } from '@gameable/physics-jolt';
import type { AddBodyCmd, CameraState, Command, FrameOutput } from '@gameable/sdk';

import { applyOutput } from '../apply';
import { createServerAdapter } from './createServerAdapter';

/** @returns A physics stand-in recording calls. */
function fakePhysics(): PhysicsService & { calls: string[] } {
  const calls: string[] = [];
  const rec =
    (name: string) =>
    (...a: unknown[]) => {
      calls.push(`${name}:${JSON.stringify(a[0])}`);
    };
  return {
    calls,
    addBody: rec('addBody'),
    removeBody: rec('removeBody'),
    setTransform: rec('setTransform'),
    setVelocity: rec('setVelocity'),
    applyImpulse: rec('applyImpulse'),
    setEnabled: rec('setEnabled'),
    moveCharacter: rec('moveCharacter'),
    groundState: () => 'on-ground',
  } as never;
}

const spawn = (entity: number): Command => ({
  tag: 'spawn' as const,
  val: {
    entity,
    asset: 7,
    position: { x: 1, y: 2, z: 3 },
    rotation: { x: 0, y: 0, z: 0, w: 1 },
    scale: { x: 1, y: 1, z: 1 },
    parent: undefined,
    visible: true,
    name: 'crate',
  },
});

/**
 * A whole `add-body`, as the guest's WIT decoding always delivers one.
 *
 * @param body Body id.
 * @param entity Entity id.
 * @returns The command.
 */
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

const out = (commands: Command[], transforms = new Float32Array(12)): FrameOutput => ({
  transforms,
  localCommands: [],
  commands,
  camera: CAMERA,
  hud: undefined,
});

describe('createServerAdapter', () => {
  it('records a spawn and its transform', () => {
    const a = createServerAdapter(fakePhysics());
    a.beginTick();
    // Transforms are applied before commands, so a row for an entity spawned
    // in the same output finds no record; the row lands on the next tick, as
    // it does on the page.
    applyOutput(a, out([spawn(5)]));
    a.beginTick();
    const rows = new Float32Array([5, 1 | 2 | 4, 9, 8, 7, 0, 0, 0, 1, 2, 2, 2]);
    applyOutput(a, out([], rows));
    const rec = a.world.entities.get(5);
    expect(rec?.asset).toBe(7);
    expect(Array.from(rec?.position ?? [])).toEqual([9, 8, 7]);
    expect(rec?.name).toBe('crate');
  });

  it('writes only the lanes a transform row flags, and bumps serial', () => {
    const a = createServerAdapter(fakePhysics());
    a.beginTick();
    applyOutput(a, out([spawn(5)]));
    const spawnedAt = a.world.entities.get(5)?.serial ?? -1;
    a.beginTick();
    applyOutput(a, out([], new Float32Array([5, 1, 9, 8, 7, 0, 1, 0, 0, 4, 4, 4])));
    const rec = a.world.entities.get(5);
    expect(Array.from(rec?.position ?? [])).toEqual([9, 8, 7]);
    expect(Array.from(rec?.rotation ?? [])).toEqual([0, 0, 0, 1]);
    expect(Array.from(rec?.scale ?? [])).toEqual([1, 1, 1]);
    expect(rec?.serial).toBeGreaterThan(spawnedAt);
  });

  it('forwards physics commands and maps bodies to entities', () => {
    const p = fakePhysics();
    const a = createServerAdapter(p);
    a.beginTick();
    applyOutput(a, out([spawn(5), addBody(11, 5)]));
    expect(p.calls[0]).toMatch(/^addBody:/);
    expect(a.world.entityOfBody(11)).toBe(5);
    expect(a.world.entities.get(5)?.body).toBe(11);
    a.applyBodyRows(new Float32Array([11, 0, 4, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 1]), 1);
    expect(a.world.entities.get(5)?.position[1]).toBe(4);
  });

  it('maps add-body to the physics world as the page does', () => {
    const p = fakePhysics();
    const a = createServerAdapter(p);
    a.beginTick();
    applyOutput(a, out([spawn(5), addBody(11, 5)]));
    const args = JSON.parse(p.calls[0].slice('addBody:'.length)) as Record<string, unknown>;
    expect(args).toMatchObject({
      id: 11,
      shape: 'box',
      dims: [0.5, 0.5, 0.5],
      position: [0, 1, 0],
      rotation: [0, 0, 0, 1],
      kind: 'dynamic',
      layer: 1,
      mask: 1,
    });
  });

  it('keeps a rotation the guest authored this tick over the body row', () => {
    const a = createServerAdapter(fakePhysics());
    a.beginTick();
    applyOutput(a, out([spawn(5), addBody(11, 5)]));
    a.beginTick();
    applyOutput(a, out([], new Float32Array([5, 2, 0, 0, 0, 0, 1, 0, 0, 1, 1, 1])));
    a.applyBodyRows(new Float32Array([11, 3, 3, 3, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 1]), 1);
    const rec = a.world.entities.get(5);
    expect(Array.from(rec?.position ?? [])).toEqual([3, 3, 3]);
    expect(Array.from(rec?.rotation ?? [])).toEqual([0, 1, 0, 0]);
    a.beginTick();
    a.applyBodyRows(new Float32Array([11, 3, 3, 3, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 1]), 1);
    expect(Array.from(rec?.rotation ?? [])).toEqual([0, 0, 0, 1]);
  });

  it('keeps say and play-sound as transient, cleared by beginTick', () => {
    const a = createServerAdapter(fakePhysics());
    a.beginTick();
    applyOutput(
      a,
      out([{ tag: 'say', val: { entity: 1, text: 'hi', audio: undefined, visemes: undefined } }]),
    );
    expect(a.transient.map((c) => c.tag)).toEqual(['say']);
    a.beginTick();
    expect(a.transient).toEqual([]);
  });

  it('copies transient commands and reuses the copies next tick', () => {
    const a = createServerAdapter(fakePhysics());
    const position = { x: 1, y: 2, z: 3 };
    const sound: Command = {
      tag: 'play-sound',
      val: { sound: 3, asset: 4, position, volume: 1, pitch: 1, looping: false, bus: 'sfx' },
    };
    a.beginTick();
    applyOutput(a, out([sound]));
    const first = a.transient[0];
    position.x = 99;
    expect(first).toEqual({ ...sound, val: { ...sound.val, position: { x: 1, y: 2, z: 3 } } });
    a.beginTick();
    applyOutput(a, out([sound]));
    expect(a.transient[0]).toBe(first);
    expect(first.tag === 'play-sound' && first.val.position?.x).toBe(99);
  });

  it('copies the camera and HUD onto player 0', () => {
    const a = createServerAdapter(fakePhysics());
    const camera = {
      mode: 'third-person',
      projection: 'perspective',
      position: { x: 1, y: 2, z: 3 },
      rotation: { x: 0, y: 0, z: 0, w: 1 },
      target: undefined,
      fovYDeg: 60,
      near: 0.1,
      far: 500,
      follow: 5,
      armLength: 4,
      offset: { x: 0, y: 1, z: 0 },
    } satisfies CameraState;
    a.beginTick();
    applyOutput(a, { ...out([]), camera, hud: '{"hp":3}' });
    camera.position.x = 42;
    expect(a.perPlayer[0].camera?.position.x).toBe(1);
    expect(a.perPlayer[0].camera?.follow).toBe(5);
    expect(a.perPlayer[0].hud).toBe('{"hp":3}');
    a.beginTick();
    applyOutput(a, out([]));
    expect(a.perPlayer[0].hud).toBe('{"hp":3}');
  });

  it('despawn removes the record and its body mapping', () => {
    const a = createServerAdapter(fakePhysics());
    a.beginTick();
    applyOutput(a, out([spawn(5), addBody(11, 5), { tag: 'despawn', val: 5 }]));
    expect(a.world.entities.has(5)).toBe(false);
    expect(a.world.entityOfBody(11)).toBe(0);
  });

  it('remove-body forgets the body on the record and in physics', () => {
    const p = fakePhysics();
    const a = createServerAdapter(p);
    a.beginTick();
    applyOutput(a, out([spawn(5), addBody(11, 5), { tag: 'remove-body', val: 11 }]));
    expect(a.world.entities.get(5)?.body).toBeUndefined();
    expect(a.world.entityOfBody(11)).toBe(0);
    expect(p.calls).toContain('removeBody:11');
  });

  it('records animation and character state on the entity', () => {
    const a = createServerAdapter(fakePhysics());
    a.beginTick();
    applyOutput(
      a,
      out([
        spawn(5),
        {
          tag: 'set-anim',
          val: { entity: 5, clip: 'walk', looping: true, speed: 2, fadeMs: 0, weight: 1 },
        },
        {
          tag: 'spawn-character',
          val: {
            entity: 5,
            bundle: 9,
            position: { x: 0, y: 0, z: 0 },
            rotation: { x: 0, y: 0, z: 0, w: 1 },
          },
        },
        {
          tag: 'set-character-state',
          val: { entity: 5, state: 'run', velocity: { x: 1, y: 0, z: 0 }, grounded: false },
        },
      ]),
    );
    const rec = a.world.entities.get(5);
    expect(rec?.anim).toEqual({ clip: 'walk', looping: true, speed: 2 });
    expect(rec?.character).toEqual({
      bundle: 9,
      state: 'run',
      grounded: false,
      velocity: { x: 1, y: 0, z: 0 },
    });
  });

  it('warns once for commands a server cannot honour', () => {
    const warnings: string[] = [];
    const a = createServerAdapter(fakePhysics(), { warn: (m) => warnings.push(m) });
    a.beginTick();
    const lock: Command = { tag: 'set-pointer-lock', val: true };
    applyOutput(a, out([lock, lock, { tag: 'set-time-scale', val: 0.5 }]));
    expect(warnings).toHaveLength(2);
  });

  it('snapshot is JSON with plain arrays', () => {
    const a = createServerAdapter(fakePhysics());
    a.beginTick();
    applyOutput(a, out([spawn(5)]));
    const json = JSON.stringify(a.world.snapshot());
    expect(
      (JSON.parse(json) as { entities: { position: number[] }[] }).entities[0].position,
    ).toEqual([1, 2, 3]);
  });
});
