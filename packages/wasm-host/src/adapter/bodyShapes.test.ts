import { describe, expect, it } from 'vitest';
import type { AddBodyCmd } from '@gameable/sdk';

import { addBodySkip, isGuestShape, shapeKind, toJoltBody } from './bodyShapes';

describe('toJoltBody', () => {
  it('maps a capsule character body to the physics module spelling', () => {
    const args: AddBodyCmd = {
      body: 3,
      entity: 9,
      kind: 'character',
      shape: { kind: 'capsule', halfExtents: { x: 0.35, y: 0.6, z: 0 }, asset: undefined },
      position: { x: 1, y: 2, z: 3 },
      rotation: { x: 0, y: 0, z: 0, w: 1 },
      mass: 80,
      friction: 0.2,
      restitution: 0,
      linearDamping: 0.1,
      angularDamping: 0.2,
      layer: { player: true },
      mask: { defaultLayer: true, staticGeometry: true },
      flags: { lockRotation: true },
    };
    const kind = shapeKind(args.shape.kind);
    expect(isGuestShape(kind)).toBe(true);
    if (!isGuestShape(kind)) return;
    expect(toJoltBody(args, kind)).toEqual({
      id: 3,
      shape: 'capsule',
      dims: [0.35, 0.6],
      position: [1, 2, 3],
      rotation: [0, 0, 0, 1],
      mass: 80,
      kind: 'character',
      layer: 4,
      mask: 3,
      friction: 0.2,
      restitution: 0,
      linearDamping: 0.1,
      angularDamping: 0.2,
      flags: {
        reportContacts: undefined,
        sensor: undefined,
        noSleep: undefined,
        lockRotation: true,
        ccd: undefined,
      },
    });
  });

  it('names the skip for shapes the guest cannot build', () => {
    expect(isGuestShape(shapeKind('mesh'))).toBe(false);
    expect(addBodySkip('mesh', 'mesh').key).toBe('host-shape:mesh');
    expect(addBodySkip('plane', null).key).toBe('no-jolt-shape:plane');
  });
});
