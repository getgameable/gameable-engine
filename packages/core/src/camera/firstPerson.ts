/**
 * The first-person camera rig.
 *
 * A pure function of `(feet position, yaw, pitch)` onto a camera. It owns no
 * input, no physics and no state beyond the last pose, so it is the same rig in
 * a game, in a replay and in a test.
 */
import type { PerspectiveCamera } from 'three/webgpu';

/** Anything with `x`, `y` and `z`. Avoids allocating a `Vector3` per call. */
export interface Vector3Like {
  /** X component. */
  readonly x: number;
  /** Y component. */
  readonly y: number;
  /** Z component. */
  readonly z: number;
}

/** Default eye height above the feet, in metres. */
export const DEFAULT_EYE_HEIGHT = 1.7;

/** Default pitch limit: just short of straight up or down, in radians. */
export const DEFAULT_MAX_PITCH = Math.PI / 2 - 0.001;

/** Options accepted by {@link createFirstPersonRig}. */
export interface FirstPersonRigOptions {
  /** The camera to drive. */
  readonly camera: PerspectiveCamera;
  /** Metres from the given position up to the eyes. Defaults to `1.7`. */
  readonly eyeHeight?: number;
  /** Pitch is clamped to plus or minus this, in radians. */
  readonly maxPitch?: number;
}

/** A first-person camera rig. */
export interface FirstPersonRig {
  /** The camera being driven. */
  readonly camera: PerspectiveCamera;
  /** Metres from the pose position up to the eyes. Writable: crouching changes it. */
  eyeHeight: number;
  /** Last applied yaw, in radians. */
  readonly yaw: number;
  /** Last applied pitch, in radians, after clamping. */
  readonly pitch: number;

  /**
   * Place the camera.
   *
   * `position` is the body's position — feet, or capsule base — not the eyes;
   * `eyeHeight` is added to `y`.
   *
   * @param position Body position in world space.
   * @param yaw Rotation about world +Y, in radians. `0` looks down −Z.
   * @param pitch Rotation about the camera's local +X, in radians. Positive looks up.
   */
  setPose(position: Vector3Like, yaw: number, pitch: number): void;
}

/**
 * Build a first-person rig.
 *
 * The camera's Euler order is set to `YXZ` once, which is what makes yaw and
 * pitch independent: yaw always turns about world up, pitch always about the
 * camera's own right, and there is no roll.
 *
 * @param options Camera, eye height and pitch limit.
 * @returns The rig.
 *
 * @example
 * ```ts
 * import { createFirstPersonRig } from 'gameable/core';
 * import { PerspectiveCamera } from 'three/webgpu';
 *
 * const rig = createFirstPersonRig({ camera: new PerspectiveCamera(), eyeHeight: 1.7 });
 * rig.setPose({ x: 0, y: 0, z: 0 }, Math.PI, 0);
 * console.log(rig.camera.position.y); // 1.7
 * ```
 */
export function createFirstPersonRig(options: FirstPersonRigOptions): FirstPersonRig {
  const { camera } = options;
  const maxPitch = options.maxPitch ?? DEFAULT_MAX_PITCH;
  camera.rotation.order = 'YXZ';

  let yaw = 0;
  let pitch = 0;
  let eyeHeight = options.eyeHeight ?? DEFAULT_EYE_HEIGHT;

  return {
    camera,

    get eyeHeight() {
      return eyeHeight;
    },
    set eyeHeight(value: number) {
      eyeHeight = value;
    },
    get yaw() {
      return yaw;
    },
    get pitch() {
      return pitch;
    },

    setPose(position, nextYaw, nextPitch) {
      yaw = nextYaw;
      pitch = nextPitch < -maxPitch ? -maxPitch : nextPitch > maxPitch ? maxPitch : nextPitch;
      camera.position.set(position.x, position.y + eyeHeight, position.z);
      camera.rotation.set(pitch, yaw, 0);
    },
  };
}
