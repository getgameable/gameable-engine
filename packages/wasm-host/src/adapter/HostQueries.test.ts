import { describe, expect, it } from 'vitest';
import { createAssetRegistry, parseManifest } from '@gameable/assets';
import type { PhysicsService } from '@gameable/physics-jolt';

import { HostQueries } from './HostQueries';

const FILTER = { layers: { enemy: true }, solidOnly: true } as const;

/**
 * The three physics calls the queries make, each overridable.
 *
 * @param overrides Replacement members.
 * @returns A physics stand-in.
 */
function fakePhysics(overrides: Partial<Record<string, unknown>> = {}): PhysicsService {
  return {
    raycast: () => null,
    overlapSphereInto: () => 0,
    readBodyBounds: () => false,
    ...overrides,
  } as unknown as PhysicsService;
}

const assets = createAssetRegistry({
  manifest: parseManifest({ version: 1, assets: [] }),
  loaders: {},
});

describe('HostQueries', () => {
  it('caps overlap-sphere at maxOverlaps, whatever the physics found', () => {
    const physics = fakePhysics({
      overlapSphereInto: (_c: unknown, _r: unknown, _m: unknown, out: Uint32Array) => {
        // The buffer handed in is the pool, sized by the option.
        for (let i = 0; i < out.length; i += 1) out[i] = i + 1;
        return 10;
      },
    });
    const host = new HostQueries(physics, (body) => body * 100, assets, { maxOverlaps: 3 });

    const hits = host.overlapSphere({ x: 0, y: 0, z: 0 }, 2, FILTER, 8);
    expect(hits.map((h) => h.body)).toEqual([1, 2, 3]);
    expect(hits.map((h) => h.entity)).toEqual([100, 200, 300]);
    // A smaller per-call limit wins over the pool size.
    expect(host.overlapSphere({ x: 0, y: 0, z: 0 }, 2, FILTER, 2)).toHaveLength(2);
  });

  it('asks a physics resolver again until it answers', () => {
    let registered: PhysicsService | null = null;
    const host = new HostQueries(
      () => registered,
      () => 4,
      assets,
    );
    const ray = [{ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: -1 }, 10, FILTER] as const;

    expect(host.raycast(...ray)).toBeNull();
    registered = fakePhysics({
      raycast: () => ({ body: 2, px: 0, py: 0, pz: -3, nx: 0, ny: 0, nz: 1, distance: 3 }),
    });
    expect(host.raycast(...ray)).toMatchObject({ body: 2, entity: 4, distance: 3 });
  });
});
