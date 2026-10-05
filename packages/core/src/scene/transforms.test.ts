import { Object3D } from 'three/webgpu';
import { describe, expect, it } from 'vitest';

import { DEFAULT_TRANSFORM_CAPACITY, TransformStore } from './transforms.js';

/**
 * A quaternion for a rotation about +Y.
 *
 * @param radians Rotation angle.
 * @returns The quaternion as `[x, y, z, w]`.
 */
function yaw(radians: number): [number, number, number, number] {
  return [0, Math.sin(radians / 2), 0, Math.cos(radians / 2)];
}

describe('capacity', () => {
  it('reserves a default capacity', () => {
    expect(new TransformStore().capacity).toBe(DEFAULT_TRANSFORM_CAPACITY);
  });

  it('grows by doubling until the id fits, keeping existing data', () => {
    const store = new TransformStore(4);
    store.setPosition(0, 1, 2, 3);

    store.ensure(9);

    expect(store.capacity).toBe(16);
    expect(store.getPosition(0, [0, 0, 0])).toEqual([1, 2, 3]);
    expect(store.has(0)).toBe(true);
  });

  it('grows implicitly on a write past the end', () => {
    const store = new TransformStore(2);
    store.setPosition(100, 5, 5, 5);
    expect(store.capacity).toBeGreaterThan(100);
    expect(store.getPosition(100, [0, 0, 0])).toEqual([5, 5, 5]);
  });

  it('gives new slots unit scale and identity rotation', () => {
    const store = new TransformStore(2);
    store.setPosition(50, 0, 0, 0);
    expect(store.getQuaternion(50, [0, 0, 0, 0])).toEqual([0, 0, 0, 1]);

    const object = new Object3D();
    store.writeInterpolated(50, object, 1);
    expect(object.scale.toArray()).toEqual([1, 1, 1]);
  });

  it('rejects a negative or fractional id', () => {
    const store = new TransformStore(4);
    expect(() => {
      store.ensure(-1);
    }).toThrow(RangeError);
    expect(() => {
      store.ensure(4.5);
    }).toThrow(RangeError);
  });
});

describe('has and clear', () => {
  it('reports untouched and out-of-range slots as absent', () => {
    const store = new TransformStore(4);
    expect(store.has(0)).toBe(false);
    expect(store.has(999)).toBe(false);
    expect(store.has(-1)).toBe(false);
  });

  it('forgets a slot on clear', () => {
    const store = new TransformStore(4);
    store.setPosition(1, 9, 9, 9);
    expect(store.has(1)).toBe(true);
    store.clear(1);
    expect(store.has(1)).toBe(false);
    expect(store.getPosition(1, [0, 0, 0])).toEqual([0, 0, 0]);
    expect(store.getQuaternion(1, [0, 0, 0, 0])).toEqual([0, 0, 0, 1]);
  });
});

describe('writeInterpolated', () => {
  it('returns false and leaves the object alone for an unknown entity', () => {
    const store = new TransformStore(4);
    const object = new Object3D();
    object.position.set(1, 1, 1);

    expect(store.writeInterpolated(2, object, 0.5)).toBe(false);
    expect(object.position.toArray()).toEqual([1, 1, 1]);
  });

  it('does not interpolate a freshly written entity in from the origin', () => {
    const store = new TransformStore(4);
    store.setPosition(1, 10, 0, 0);
    const object = new Object3D();

    store.writeInterpolated(1, object, 0);

    expect(object.position.toArray()).toEqual([10, 0, 0]);
  });

  it('blends position linearly between the committed and current values', () => {
    const store = new TransformStore(4);
    store.setPosition(1, 0, 0, 0);
    store.commit();
    store.setPosition(1, 10, 20, -30);
    const object = new Object3D();

    store.writeInterpolated(1, object, 0.5);
    expect(object.position.toArray()).toEqual([5, 10, -15]);

    store.writeInterpolated(1, object, 0);
    expect(object.position.toArray()).toEqual([0, 0, 0]);

    store.writeInterpolated(1, object, 1);
    expect(object.position.toArray()).toEqual([10, 20, -30]);
  });

  it('blends scale', () => {
    const store = new TransformStore(4);
    store.setScale(1, 1, 1, 1);
    store.commit();
    store.setScale(1, 3, 3, 3);
    const object = new Object3D();

    store.writeInterpolated(1, object, 0.5);

    expect(object.scale.toArray()).toEqual([2, 2, 2]);
  });

  it('slerps a 90 degree yaw to 45 degrees at alpha 0.5', () => {
    const store = new TransformStore(4);
    store.setQuaternion(1, ...yaw(0));
    store.commit();
    store.setQuaternion(1, ...yaw(Math.PI / 2));
    const object = new Object3D();

    store.writeInterpolated(1, object, 0.5);

    const expected = yaw(Math.PI / 4);
    expect(object.quaternion.x).toBeCloseTo(expected[0], 6);
    expect(object.quaternion.y).toBeCloseTo(expected[1], 6);
    expect(object.quaternion.z).toBeCloseTo(expected[2], 6);
    expect(object.quaternion.w).toBeCloseTo(expected[3], 6);
  });

  it('takes the short way round when the quaternions have opposite signs', () => {
    const store = new TransformStore(4);
    store.setQuaternion(1, ...yaw(0));
    store.commit();
    // The same rotation as yaw(PI/2), negated: the long way is 270 degrees.
    const [x, y, z, w] = yaw(Math.PI / 2);
    store.setQuaternion(1, -x, -y, -z, -w);
    const object = new Object3D();

    store.writeInterpolated(1, object, 0.5);

    // 45 degrees, up to the sign convention.
    const expected = yaw(Math.PI / 4);
    expect(Math.abs(object.quaternion.y)).toBeCloseTo(Math.abs(expected[1]), 6);
    expect(Math.abs(object.quaternion.w)).toBeCloseTo(Math.abs(expected[3]), 6);
  });

  it('produces a unit quaternion', () => {
    const store = new TransformStore(4);
    store.setQuaternion(1, ...yaw(0.3));
    store.commit();
    store.setQuaternion(1, ...yaw(2.9));
    const object = new Object3D();

    for (const alpha of [0, 0.25, 0.5, 0.75, 1]) {
      store.writeInterpolated(1, object, alpha);
      expect(object.quaternion.length()).toBeCloseTo(1, 6);
    }
  });

  it('clamps alpha outside [0, 1]', () => {
    const store = new TransformStore(4);
    store.setPosition(1, 0, 0, 0);
    store.commit();
    store.setPosition(1, 10, 0, 0);
    const object = new Object3D();

    store.writeInterpolated(1, object, -5);
    expect(object.position.x).toBe(0);
    store.writeInterpolated(1, object, 5);
    expect(object.position.x).toBe(10);
  });
});

describe('change tracking', () => {
  it('writes a fresh slot once, then leaves the object alone until it moves', () => {
    const store = new TransformStore(4);
    store.setPosition(1, 5, 6, 7);
    expect(store.isDirty(1)).toBe(true);

    const object = new Object3D();
    expect(store.writeInterpolated(1, object, 0.3)).toBe(true);
    expect(object.position.toArray()).toEqual([5, 6, 7]);
    expect(store.isDirty(1)).toBe(false);

    // Nothing moved: the object is not touched, so its world matrix stays clean.
    object.position.set(-1, -1, -1);
    expect(store.writeInterpolated(1, object, 0.9)).toBe(true);
    expect(object.position.toArray()).toEqual([-1, -1, -1]);
  });

  it('re-writing the same value does not mark the slot as moved', () => {
    const store = new TransformStore(4);
    store.set(1, 1, 2, 3, 0, 0, 0, 1, 1, 1, 1);
    store.writeInterpolated(1, new Object3D(), 1);
    store.commit();
    store.set(1, 1, 2, 3, 0, 0, 0, 1, 1, 1, 1);
    expect(store.isDirty(1)).toBe(false);
  });

  it('writes every rendered frame while previous and current differ', () => {
    const store = new TransformStore(4);
    store.setPosition(1, 0, 0, 0);
    store.commit();
    store.setPosition(1, 10, 0, 0);

    for (const alpha of [0, 0.25, 0.5, 0.75, 1]) {
      const object = new Object3D();
      store.writeInterpolated(1, object, alpha);
      expect(object.position.x).toBeCloseTo(10 * alpha, 6);
    }
  });

  it('delivers the settled value once after the motion ends', () => {
    const store = new TransformStore(4);
    store.setPosition(1, 0, 0, 0);
    store.commit();
    store.setPosition(1, 10, 0, 0);
    const object = new Object3D();
    store.writeInterpolated(1, object, 0.5);
    expect(object.position.x).toBe(5);

    store.commit(); // previous now equals current: settled, but the object holds 5
    expect(store.isDirty(1)).toBe(true);
    store.writeInterpolated(1, object, 0);
    expect(object.position.x).toBe(10);
    expect(store.isDirty(1)).toBe(false);
  });

  it('commit scans only up to the high-water mark', () => {
    const store = new TransformStore(256);
    expect(store.highWater).toBe(0);
    store.setPosition(3, 1, 1, 1);
    expect(store.highWater).toBe(4);
    store.commit();
    expect(store.getPosition(200, [9, 9, 9])).toEqual([0, 0, 0]);
    store.ensure(300);
    store.setPosition(300, 2, 2, 2);
    expect(store.highWater).toBe(301);
    store.commit();
    const object = new Object3D();
    store.writeInterpolated(300, object, 0);
    expect(object.position.x).toBe(2);
  });

  it('re-arms a cleared slot on reuse', () => {
    const store = new TransformStore(4);
    store.setPosition(1, 5, 0, 0);
    store.writeInterpolated(1, new Object3D(), 1);
    store.clear(1);
    expect(store.isDirty(1)).toBe(false);
    store.setPosition(1, 7, 0, 0);
    const object = new Object3D();
    store.writeInterpolated(1, object, 0);
    expect(object.position.x).toBe(7);
  });
});

describe('commit and snap', () => {
  it('makes the current transform the previous one for every changed slot', () => {
    const store = new TransformStore(4);
    store.setPosition(1, 0, 0, 0);
    store.setPosition(2, 5, 0, 0);
    store.commit();
    store.setPosition(1, 10, 0, 0);
    store.setPosition(2, 15, 0, 0);
    store.commit();

    const object = new Object3D();
    store.writeInterpolated(1, object, 0);
    expect(object.position.x).toBe(10);
    store.writeInterpolated(2, object, 0);
    expect(object.position.x).toBe(15);
  });

  it('snap collapses one entity without touching the others', () => {
    const store = new TransformStore(4);
    store.setPosition(1, 0, 0, 0);
    store.setPosition(2, 0, 0, 0);
    store.commit();
    store.setPosition(1, 100, 0, 0);
    store.setPosition(2, 100, 0, 0);

    store.snap(1);

    const object = new Object3D();
    store.writeInterpolated(1, object, 0);
    expect(object.position.x).toBe(100);
    store.writeInterpolated(2, object, 0);
    expect(object.position.x).toBe(0);
  });
});

describe('set', () => {
  it('writes position, rotation and scale in one call', () => {
    const store = new TransformStore(4);
    store.set(3, 1, 2, 3, ...yaw(Math.PI), 2, 2, 2);
    const object = new Object3D();

    store.writeInterpolated(3, object, 1);

    expect(object.position.toArray()).toEqual([1, 2, 3]);
    expect(object.scale.toArray()).toEqual([2, 2, 2]);
    expect(Math.abs(object.quaternion.y)).toBeCloseTo(1, 6);
  });
});
