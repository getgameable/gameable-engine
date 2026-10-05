/**
 * The third-person spring-arm camera rig.
 *
 * The camera sits on a sphere around a pivot above the target and looks back at
 * it. When something is in the way, the arm shortens: `collisionProbe` is asked
 * how far the ray from pivot to camera gets, and the camera is pulled in to just
 * short of that.
 *
 * The probe is injected rather than imported, so this file has no dependency on
 * physics. `gameable/physics` supplies one built on `raycast`; a test
 * supplies a function that returns a number.
 */
import type { PerspectiveCamera } from 'three/webgpu';

import type { Vector3Like } from './firstPerson.js';

/** Default height of the orbit pivot above the target, in metres. */
export const DEFAULT_PIVOT_HEIGHT = 1.5;

/** Default closest the arm may pull in, in metres. */
export const DEFAULT_MIN_DISTANCE = 0.4;

/** Default gap left between the camera and whatever the probe hit, in metres. */
export const DEFAULT_COLLISION_PADDING = 0.15;

/** Default pitch limit, in radians. */
export const DEFAULT_MAX_PITCH = Math.PI / 2 - 0.05;

/**
 * Asks how far a ray gets before it hits something.
 *
 * @param from Start of the ray, the orbit pivot.
 * @param to Where the camera would like to be.
 * @returns Distance from `from` to the hit, in metres, or `null` for a clear line.
 */
export type CollisionProbe = (from: Vector3Like, to: Vector3Like) => number | null;

/** Options accepted by {@link createThirdPersonRig}. */
export interface ThirdPersonRigOptions {
  /** The camera to drive. */
  readonly camera: PerspectiveCamera;
  /** Height of the orbit pivot above the target position. Defaults to `1.5`. */
  readonly pivotHeight?: number;
  /** Closest the arm may pull in. Defaults to `0.4`. */
  readonly minDistance?: number;
  /** Gap left between camera and obstacle. Defaults to `0.15`. */
  readonly collisionPadding?: number;
  /** Pitch is clamped to plus or minus this, in radians. */
  readonly maxPitch?: number;
  /** Obstacle probe. Omit for a rig that never collides. */
  readonly collisionProbe?: CollisionProbe;
}

/** A third-person orbit camera with a collision-aware spring arm. */
export interface ThirdPersonRig {
  /** The camera being driven. */
  readonly camera: PerspectiveCamera;
  /** Obstacle probe. Assign to swap it at runtime, or `null` to disable collision. */
  collisionProbe: CollisionProbe | null;
  /** Height of the orbit pivot above the target. */
  pivotHeight: number;
  /** Requested arm length, before collision. */
  readonly distance: number;
  /** Arm length actually used last frame, after collision. */
  readonly actualDistance: number;
  /** Last applied yaw, in radians. */
  readonly yaw: number;
  /** Last applied pitch, in radians, after clamping. */
  readonly pitch: number;

  /**
   * Point the rig at a target and apply the result.
   *
   * @param position The target's world position, at its feet.
   */
  setTarget(position: Vector3Like): void;

  /**
   * Set the orbit and apply the result.
   *
   * @param yaw Rotation about world +Y, in radians. `0` puts the camera on +Z.
   * @param pitch Rotation above the horizon, in radians. Positive looks down at the target.
   * @param distance Requested arm length, in metres.
   */
  setOrbit(yaw: number, pitch: number, distance: number): void;

  /**
   * Set the target and the orbit together and apply once.
   *
   * The per-frame entry point: one probe, one camera write, instead of the two
   * that calling `setTarget` then `setOrbit` would cost.
   *
   * @param position The target's world position, at its feet.
   * @param yaw Rotation about world +Y, in radians.
   * @param pitch Rotation above the horizon, in radians.
   * @param distance Requested arm length, in metres.
   */
  setTargetAndOrbit(position: Vector3Like, yaw: number, pitch: number, distance: number): void;

  /**
   * Re-run the probe and reposition the camera with the current target and orbit.
   *
   * Both setters call this; you only need it when the world changed but the
   * inputs did not.
   */
  apply(): void;
}

/**
 * Build a third-person rig.
 *
 * @param options Camera, pivot height, arm limits and the collision probe.
 * @returns The rig.
 *
 * @example
 * ```ts
 * import { createThirdPersonRig } from 'gameable/core';
 * import { PerspectiveCamera } from 'three/webgpu';
 *
 * const rig = createThirdPersonRig({ camera: new PerspectiveCamera(), pivotHeight: 1.5 });
 * rig.setTarget({ x: 0, y: 0, z: 0 });
 * rig.setOrbit(0, 0, 4);
 * console.log(rig.camera.position.z); // 4
 * ```
 */
export function createThirdPersonRig(options: ThirdPersonRigOptions): ThirdPersonRig {
  const { camera } = options;
  const minDistance = options.minDistance ?? DEFAULT_MIN_DISTANCE;
  const padding = options.collisionPadding ?? DEFAULT_COLLISION_PADDING;
  const maxPitch = options.maxPitch ?? DEFAULT_MAX_PITCH;

  let pivotHeight = options.pivotHeight ?? DEFAULT_PIVOT_HEIGHT;
  let probe: CollisionProbe | null = options.collisionProbe ?? null;

  let targetX = 0;
  let targetY = 0;
  let targetZ = 0;
  let yaw = 0;
  let pitch = 0;
  let distance = 4;
  let actualDistance = 4;

  // Reused across frames: the rig must not allocate in `update`.
  const pivot = { x: 0, y: 0, z: 0 };
  const desired = { x: 0, y: 0, z: 0 };

  /**
   * Recompute the camera transform from the stored target and orbit.
   */
  function apply(): void {
    pivot.x = targetX;
    pivot.y = targetY + pivotHeight;
    pivot.z = targetZ;

    // Unit vector from the pivot towards where the camera wants to sit.
    const cosPitch = Math.cos(pitch);
    const dirX = Math.sin(yaw) * cosPitch;
    const dirY = Math.sin(pitch);
    const dirZ = Math.cos(yaw) * cosPitch;

    desired.x = pivot.x + dirX * distance;
    desired.y = pivot.y + dirY * distance;
    desired.z = pivot.z + dirZ * distance;

    let used = distance;
    if (probe !== null) {
      const hit = probe(pivot, desired);
      if (hit !== null && hit < distance) {
        used = Math.max(minDistance, hit - padding);
      }
    }
    actualDistance = used;

    camera.position.set(pivot.x + dirX * used, pivot.y + dirY * used, pivot.z + dirZ * used);
    camera.lookAt(pivot.x, pivot.y, pivot.z);
  }

  /**
   * Store an orbit without applying it.
   *
   * @param nextYaw Yaw in radians.
   * @param nextPitch Pitch in radians, clamped.
   * @param nextDistance Arm length in metres, floored at `minDistance`.
   */
  function setOrbitSilently(nextYaw: number, nextPitch: number, nextDistance: number): void {
    yaw = nextYaw;
    pitch = nextPitch < -maxPitch ? -maxPitch : nextPitch > maxPitch ? maxPitch : nextPitch;
    distance = Math.max(minDistance, nextDistance);
  }

  return {
    camera,

    get collisionProbe() {
      return probe;
    },
    set collisionProbe(value: CollisionProbe | null) {
      probe = value;
    },
    get pivotHeight() {
      return pivotHeight;
    },
    set pivotHeight(value: number) {
      pivotHeight = value;
    },
    get distance() {
      return distance;
    },
    get actualDistance() {
      return actualDistance;
    },
    get yaw() {
      return yaw;
    },
    get pitch() {
      return pitch;
    },

    setTarget(position) {
      targetX = position.x;
      targetY = position.y;
      targetZ = position.z;
      apply();
    },

    setOrbit(nextYaw, nextPitch, nextDistance) {
      setOrbitSilently(nextYaw, nextPitch, nextDistance);
      apply();
    },

    setTargetAndOrbit(position, nextYaw, nextPitch, nextDistance) {
      targetX = position.x;
      targetY = position.y;
      targetZ = position.z;
      setOrbitSilently(nextYaw, nextPitch, nextDistance);
      apply();
    },

    apply,
  };
}
