import { describe, expect, it } from 'vitest';
import { createAssetRegistry, parseManifest } from '@gameable/assets';
import type { PhysicsService } from '@gameable/physics-jolt';
import type { AddBodyCmd } from '@gameable/sdk';

import { createServerHost } from './ServerHost';
import { createServerAdapter } from './createServerAdapter';
import type { ServerAdapter } from './ServerAdapter';

const FILTER = { layers: { enemy: true }, solidOnly: true } as const;
const ORIGIN = { x: 0, y: 0, z: 0 };
const DOWN = { x: 0, y: -1, z: 0 };
const IDENTITY = { x: 0, y: 0, z: 0, w: 1 };
const ONE = { x: 1, y: 1, z: 1 };

/** The manifest the brief names: one splat called `arena`. */
const assets = createAssetRegistry({
  manifest: parseManifest({ version: 1, assets: [{ id: 'arena', type: 'splat', src: 'x.spz' }] }),
  loaders: {},
});

/**
 * A physics stand-in: the body calls the adapter forwards, and a raycast that
 * hits body 11 two metres away unless overridden.
 *
 * @param raycast Replacement `raycast`.
 * @returns The stand-in.
 */
function fakePhysics(raycast?: PhysicsService['raycast']): PhysicsService {
  const ignore = (): void => undefined;
  return {
    addBody: ignore,
    removeBody: ignore,
    setTransform: ignore,
    setVelocity: ignore,
    applyImpulse: ignore,
    setEnabled: ignore,
    moveCharacter: ignore,
    groundState: () => 'on-ground',
    raycast:
      raycast ?? (() => ({ body: 11, px: 0, py: -2, pz: 0, nx: 0, ny: 1, nz: 0, distance: 2 })),
    overlapSphereInto: () => 0,
    readBodyBounds: () => false,
  } as unknown as PhysicsService;
}

/**
 * A box body for an entity.
 *
 * @param body Body id.
 * @param entity Entity id.
 * @returns The command.
 */
function box(body: number, entity: number): AddBodyCmd {
  return {
    body,
    entity,
    kind: 'fixed',
    shape: { kind: 'box', halfExtents: { x: 1, y: 1, z: 1 }, asset: undefined },
    position: ORIGIN,
    rotation: IDENTITY,
    mass: 0,
    friction: 0.5,
    restitution: 0,
    linearDamping: 0,
    angularDamping: 0,
    layer: { staticGeometry: true },
    mask: { enemy: true },
    flags: {},
  };
}

/**
 * A server adapter with entities spawned and their bodies added.
 *
 * @param physics The physics stand-in.
 * @param pairs `[entity, body]` pairs.
 * @returns The adapter.
 */
function adapterWith(physics: PhysicsService, pairs: [number, number][]): ServerAdapter {
  const adapter = createServerAdapter(physics, { warn: () => undefined });
  for (const [entity, body] of pairs) {
    adapter.spawn(entity, undefined, ORIGIN, IDENTITY, ONE, { visible: true });
    adapter.addBody(box(body, entity));
  }
  return adapter;
}

describe('createServerHost', () => {
  it('resolves a manifest id to its handle and describes it', () => {
    const physics = fakePhysics();
    const host = createServerHost(physics, assets, adapterWith(physics, []));
    const handle = host.resolveId('arena');
    expect(handle).toBe(1);
    expect(host.describe(handle)).toMatchObject({
      id: 1,
      name: 'arena',
      kind: 'splat',
      ready: false,
      hasCollider: false,
    });
    expect(host.resolveId('nope')).toBe(0);
  });

  it('reports the entity the world record maps the hit body to', () => {
    const physics = fakePhysics();
    const host = createServerHost(physics, assets, adapterWith(physics, [[7, 11]]));
    const hit = host.raycast(ORIGIN, DOWN, 10, FILTER);
    expect(hit).toMatchObject({ body: 11, entity: 7, distance: 2 });
    expect(hit?.point).toEqual({ x: 0, y: -2, z: 0 });
  });

  it('re-casts past an excluded body', () => {
    let call = 0;
    const physics = fakePhysics(() => {
      call += 1;
      return call === 1
        ? { body: 11, px: 0, py: -1, pz: 0, nx: 0, ny: 1, nz: 0, distance: 1 }
        : { body: 12, px: 0, py: -4, pz: 0, nx: 0, ny: 1, nz: 0, distance: 3 };
    });
    const adapter = adapterWith(physics, [
      [7, 11],
      [8, 12],
    ]);
    const host = createServerHost(physics, assets, adapter);
    const hit = host.raycast(ORIGIN, DOWN, 10, { ...FILTER, excludeBody: 11 });
    expect(hit?.entity).toBe(8);
    // Distance accumulates across the retry: 1 + epsilon + 3.
    expect(hit?.distance).toBeCloseTo(4, 2);
  });

  it('hands back the seed it was given, 0x5eed1234 by default', () => {
    const physics = fakePhysics();
    const adapter = adapterWith(physics, []);
    expect(createServerHost(physics, assets, adapter, { seed: 42 }).seed()).toBe(42);
    expect(createServerHost(physics, assets, adapter).seed()).toBe(0x5eed1234);
  });

  it('sends guest logs to the sink', () => {
    const physics = fakePhysics();
    const lines: string[] = [];
    const host = createServerHost(physics, assets, adapterWith(physics, []), {
      log: (level, message) => lines.push(`${level}:${message}`),
    });
    host.log('warn', 'low ammo');
    expect(lines).toEqual(['warn:low ammo']);
  });
});
