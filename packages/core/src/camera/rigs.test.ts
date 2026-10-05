import { PerspectiveCamera, Vector3 } from 'three/webgpu';
import { describe, expect, it, vi } from 'vitest';

import { createFirstPersonRig, DEFAULT_EYE_HEIGHT } from './firstPerson.js';
import { createThirdPersonRig } from './thirdPerson.js';

/**
 * The direction a camera is looking, in world space.
 *
 * @param camera The camera.
 * @returns A unit vector pointing where the camera looks.
 */
function forward(camera: PerspectiveCamera): Vector3 {
  return new Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
}

describe('createFirstPersonRig', () => {
  it('puts the camera at the pose position plus the eye height', () => {
    const rig = createFirstPersonRig({ camera: new PerspectiveCamera(), eyeHeight: 1.7 });

    rig.setPose({ x: 3, y: 0, z: -4 }, 0, 0);

    expect(rig.camera.position.toArray()).toEqual([3, 1.7, -4]);
  });

  it('defaults the eye height and lets it change (crouching)', () => {
    const rig = createFirstPersonRig({ camera: new PerspectiveCamera() });
    expect(rig.eyeHeight).toBe(DEFAULT_EYE_HEIGHT);

    rig.eyeHeight = 0.9;
    rig.setPose({ x: 0, y: 2, z: 0 }, 0, 0);

    expect(rig.camera.position.y).toBeCloseTo(2.9, 6);
  });

  it('looks down -Z at yaw 0', () => {
    const rig = createFirstPersonRig({ camera: new PerspectiveCamera() });
    rig.setPose({ x: 0, y: 0, z: 0 }, 0, 0);

    const dir = forward(rig.camera);

    expect(dir.x).toBeCloseTo(0, 6);
    expect(dir.y).toBeCloseTo(0, 6);
    expect(dir.z).toBeCloseTo(-1, 6);
  });

  it('yaws about world up: +90 degrees looks down -X', () => {
    const rig = createFirstPersonRig({ camera: new PerspectiveCamera() });
    rig.setPose({ x: 0, y: 0, z: 0 }, Math.PI / 2, 0);

    const dir = forward(rig.camera);

    expect(dir.x).toBeCloseTo(-1, 6);
    expect(dir.z).toBeCloseTo(0, 6);
  });

  it('pitches up for a positive pitch, with no roll', () => {
    const rig = createFirstPersonRig({ camera: new PerspectiveCamera() });
    rig.setPose({ x: 0, y: 0, z: 0 }, 0, Math.PI / 4);

    const dir = forward(rig.camera);

    expect(dir.y).toBeCloseTo(Math.SQRT1_2, 6);
    expect(rig.camera.rotation.z).toBe(0);
    expect(rig.camera.rotation.order).toBe('YXZ');
  });

  it('keeps yaw and pitch independent when both are applied', () => {
    const rig = createFirstPersonRig({ camera: new PerspectiveCamera() });
    rig.setPose({ x: 0, y: 0, z: 0 }, Math.PI / 2, Math.PI / 4);

    const dir = forward(rig.camera);

    // Yaw still turns about world up, so the vertical component is unchanged.
    expect(dir.y).toBeCloseTo(Math.SQRT1_2, 6);
    expect(dir.x).toBeCloseTo(-Math.SQRT1_2, 6);
    expect(rig.camera.rotation.z).toBe(0);
  });

  it('clamps pitch and reports the clamped value', () => {
    const rig = createFirstPersonRig({ camera: new PerspectiveCamera(), maxPitch: 1 });

    rig.setPose({ x: 0, y: 0, z: 0 }, 0, 10);
    expect(rig.pitch).toBe(1);

    rig.setPose({ x: 0, y: 0, z: 0 }, 0, -10);
    expect(rig.pitch).toBe(-1);
  });

  it('reports the yaw it was given, unclamped', () => {
    const rig = createFirstPersonRig({ camera: new PerspectiveCamera() });
    rig.setPose({ x: 0, y: 0, z: 0 }, 99, 0);
    expect(rig.yaw).toBe(99);
  });
});

describe('createThirdPersonRig', () => {
  it('puts the camera behind the pivot at yaw 0', () => {
    const rig = createThirdPersonRig({ camera: new PerspectiveCamera(), pivotHeight: 1.5 });

    rig.setTarget({ x: 0, y: 0, z: 0 });
    rig.setOrbit(0, 0, 4);

    expect(rig.camera.position.x).toBeCloseTo(0, 6);
    expect(rig.camera.position.y).toBeCloseTo(1.5, 6);
    expect(rig.camera.position.z).toBeCloseTo(4, 6);
  });

  it('orbits: yaw 90 degrees puts the camera on +X', () => {
    const rig = createThirdPersonRig({ camera: new PerspectiveCamera(), pivotHeight: 0 });
    rig.setTarget({ x: 0, y: 0, z: 0 });
    rig.setOrbit(Math.PI / 2, 0, 5);

    expect(rig.camera.position.x).toBeCloseTo(5, 6);
    expect(rig.camera.position.z).toBeCloseTo(0, 6);
  });

  it('raises the camera for a positive pitch', () => {
    const rig = createThirdPersonRig({ camera: new PerspectiveCamera(), pivotHeight: 0 });
    rig.setTarget({ x: 0, y: 0, z: 0 });
    rig.setOrbit(0, Math.PI / 6, 10);

    expect(rig.camera.position.y).toBeCloseTo(5, 6);
    expect(rig.camera.position.z).toBeCloseTo(10 * Math.cos(Math.PI / 6), 6);
  });

  it('looks back at the pivot', () => {
    const rig = createThirdPersonRig({ camera: new PerspectiveCamera(), pivotHeight: 1.5 });
    rig.setTarget({ x: 2, y: 0, z: -3 });
    rig.setOrbit(0.7, 0.3, 6);

    const pivot = new Vector3(2, 1.5, -3);
    const toPivot = pivot.clone().sub(rig.camera.position).normalize();
    const dir = forward(rig.camera);

    expect(dir.dot(toPivot)).toBeCloseTo(1, 5);
  });

  it('tracks the target', () => {
    const rig = createThirdPersonRig({ camera: new PerspectiveCamera(), pivotHeight: 0 });
    rig.setOrbit(0, 0, 3);
    rig.setTarget({ x: 10, y: 20, z: 30 });

    expect(rig.camera.position.x).toBeCloseTo(10, 6);
    expect(rig.camera.position.y).toBeCloseTo(20, 6);
    expect(rig.camera.position.z).toBeCloseTo(33, 6);
  });

  it('sets the target and the orbit together with a single probe', () => {
    let probes = 0;
    const rig = createThirdPersonRig({
      camera: new PerspectiveCamera(),
      pivotHeight: 0,
      collisionProbe: () => {
        probes += 1;
        return null;
      },
    });
    rig.setTargetAndOrbit({ x: 10, y: 20, z: 30 }, 0, 0, 3);

    expect(probes).toBe(1);
    expect(rig.camera.position.x).toBeCloseTo(10, 6);
    expect(rig.camera.position.y).toBeCloseTo(20, 6);
    expect(rig.camera.position.z).toBeCloseTo(33, 6);
    expect(rig.distance).toBe(3);
  });

  it('shortens the arm to the probe distance, minus the padding', () => {
    const rig = createThirdPersonRig({
      camera: new PerspectiveCamera(),
      pivotHeight: 0,
      collisionPadding: 0.2,
      collisionProbe: () => 2,
    });

    rig.setTarget({ x: 0, y: 0, z: 0 });
    rig.setOrbit(0, 0, 6);

    expect(rig.distance).toBe(6);
    expect(rig.actualDistance).toBeCloseTo(1.8, 6);
    expect(rig.camera.position.z).toBeCloseTo(1.8, 6);
  });

  it('leaves the arm alone when the probe reports a clear line', () => {
    const rig = createThirdPersonRig({
      camera: new PerspectiveCamera(),
      pivotHeight: 0,
      collisionProbe: () => null,
    });
    rig.setTarget({ x: 0, y: 0, z: 0 });
    rig.setOrbit(0, 0, 6);
    expect(rig.actualDistance).toBe(6);
  });

  it('ignores a probe hit further away than the arm', () => {
    const rig = createThirdPersonRig({
      camera: new PerspectiveCamera(),
      pivotHeight: 0,
      collisionProbe: () => 100,
    });
    rig.setTarget({ x: 0, y: 0, z: 0 });
    rig.setOrbit(0, 0, 6);
    expect(rig.actualDistance).toBe(6);
  });

  it('never pulls closer than minDistance', () => {
    const rig = createThirdPersonRig({
      camera: new PerspectiveCamera(),
      pivotHeight: 0,
      minDistance: 0.5,
      collisionProbe: () => 0.01,
    });
    rig.setTarget({ x: 0, y: 0, z: 0 });
    rig.setOrbit(0, 0, 6);
    expect(rig.actualDistance).toBe(0.5);
  });

  it('hands the probe the pivot and the desired camera position', () => {
    const probe = vi.fn(() => null);
    const rig = createThirdPersonRig({
      camera: new PerspectiveCamera(),
      pivotHeight: 1.5,
      collisionProbe: probe,
    });

    rig.setTarget({ x: 1, y: 0, z: 2 });
    rig.setOrbit(0, 0, 4);

    expect(probe).toHaveBeenLastCalledWith(
      { x: 1, y: 1.5, z: 2 },
      expect.objectContaining({ x: 1, y: 1.5 }),
    );
  });

  it('reuses the same vectors, so the probe sees no fresh allocations', () => {
    const seen: object[] = [];
    const rig = createThirdPersonRig({
      camera: new PerspectiveCamera(),
      collisionProbe: (from, to) => {
        seen.push(from, to);
        return null;
      },
    });
    rig.setTarget({ x: 0, y: 0, z: 0 });
    rig.setOrbit(0, 0, 4);

    expect(seen[0]).toBe(seen[2]);
    expect(seen[1]).toBe(seen[3]);
  });

  it('can have its probe swapped or removed at runtime', () => {
    const rig = createThirdPersonRig({ camera: new PerspectiveCamera(), pivotHeight: 0 });
    rig.setTarget({ x: 0, y: 0, z: 0 });
    rig.setOrbit(0, 0, 6);
    expect(rig.actualDistance).toBe(6);

    rig.collisionProbe = () => 1;
    rig.apply();
    expect(rig.actualDistance).toBeLessThan(6);

    rig.collisionProbe = null;
    rig.apply();
    expect(rig.actualDistance).toBe(6);
  });

  it('clamps pitch and floors the requested distance', () => {
    const rig = createThirdPersonRig({
      camera: new PerspectiveCamera(),
      maxPitch: 1,
      minDistance: 0.4,
    });
    rig.setOrbit(0, 10, -3);
    expect(rig.pitch).toBe(1);
    expect(rig.distance).toBe(0.4);
  });
});
