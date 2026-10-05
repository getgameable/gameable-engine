/**
 * The camera facade.
 *
 * The guest does not own a camera object; it fills in one `camera-state`
 * record per frame and the host builds the real rig from it. This module
 * mutates the runtime's single preallocated record, so setting the camera
 * every frame costs nothing.
 */
import { Transform } from './ecs';
import { requireRuntime } from './state';
import type { LookState } from './state';
import type { CameraState, Quat, Vec3 } from './types';

/**
 * Round to f32, the precision every float in the WIT contract carries. Direct
 * mode would otherwise hand the engine `f64` and diverge from wasm mode.
 */
const f = Math.fround;

/** Options for `camera.firstPerson`. */
export interface FirstPersonOptions {
  /** Eye height above the entity origin, metres. Default 1.7. */
  eyeHeight?: number;
  /** Vertical field of view in degrees. Default 75. */
  fovYDeg?: number;
}

/** Options for `camera.follow`. */
export interface FollowOptions {
  /** Boom length behind the target, metres. Default 4. */
  distance?: number;
  /** Rig-local height offset, metres. Default 1.6. */
  height?: number;
  /** Vertical field of view in degrees. Default 60. */
  fovYDeg?: number;
  /**
   * Orbit yaw in radians about `+Y`; `0` puts the camera behind the target.
   *
   * Defaults to the built-in look accumulator. Pass it when the game keeps its
   * own orbit — a third-person camera usually wants a tighter pitch range and
   * its own sensitivity than the first-person one the accumulator is tuned for.
   */
  yaw?: number;
  /** Orbit pitch in radians; positive looks up. Defaults to the accumulator. */
  pitch?: number;
}

/**
 * Build a fresh camera record. Init only; not part of the public API.
 *
 * @returns A camera state with sane defaults.
 */
export function makeCameraState(): CameraState {
  return {
    mode: 'first-person',
    projection: 'perspective',
    position: { x: 0, y: Math.fround(1.7), z: 5 },
    rotation: { x: 0, y: 0, z: 0, w: 1 },
    target: undefined,
    fovYDeg: 75,
    // Every float in the WIT contract is an f32; rounding the defaults here
    // keeps direct mode byte-identical to wasm mode from frame 0.
    near: Math.fround(0.1),
    far: 1000,
    follow: undefined,
    armLength: 0,
    offset: { x: 0, y: 0, z: 0 },
  };
}

/**
 * Put a camera record back to the `makeCameraState` defaults, in place.
 * Not part of the public API.
 *
 * @param c The record to overwrite.
 */
export function resetCameraState(c: CameraState): void {
  const fresh = CAMERA_DEFAULTS;
  c.mode = fresh.mode;
  c.projection = fresh.projection;
  c.position.x = fresh.position.x;
  c.position.y = fresh.position.y;
  c.position.z = fresh.position.z;
  c.rotation.x = fresh.rotation.x;
  c.rotation.y = fresh.rotation.y;
  c.rotation.z = fresh.rotation.z;
  c.rotation.w = fresh.rotation.w;
  c.target = undefined;
  c.fovYDeg = fresh.fovYDeg;
  c.near = fresh.near;
  c.far = fresh.far;
  c.follow = undefined;
  c.armLength = fresh.armLength;
  c.offset.x = fresh.offset.x;
  c.offset.y = fresh.offset.y;
  c.offset.z = fresh.offset.z;
}

/** The defaults `resetCameraState` copies, built once. */
const CAMERA_DEFAULTS = makeCameraState();

/**
 * Write a yaw/pitch pair into a quaternion, in the engine's Y-up convention.
 *
 * @param out Quaternion to overwrite.
 * @param yaw Yaw in radians, around +Y.
 * @param pitch Pitch in radians, around the camera's local +X.
 * @returns Nothing; `out` is mutated.
 */
export function quatFromYawPitch(out: Quat, yaw: number, pitch: number): void {
  const cy = Math.cos(yaw * 0.5);
  const sy = Math.sin(yaw * 0.5);
  const cp = Math.cos(pitch * 0.5);
  const sp = Math.sin(pitch * 0.5);
  // q = qYaw * qPitch
  out.x = f(cy * sp);
  out.y = f(sy * cp);
  out.z = f(-sy * sp);
  out.w = f(cy * cp);
}

/**
 * What a camera facade writes: the record, the look angles it reads, and a
 * hook called after every write.
 *
 * The singleton `camera` writes the frame's camera; each player handle's
 * `camera` writes that player's own record and queues a `set-player-camera`.
 */
export interface CameraTarget {
  /** @returns The record to write. */
  camera(): CameraState;
  /** @returns The look angles `firstPerson` and `follow` default to. */
  look(): LookState;
  /** Called after every write, and when `state` is read for writing. */
  touch(): void;
}

/**
 * Build a camera facade over one target. Called once per target, never per tick.
 *
 * @param target What the facade writes.
 * @returns The facade.
 */
export function createCameraFacade(target: CameraTarget) {
  return {
    /**
     * Mount the camera at an entity's eyes.
     *
     * Yaw and pitch come from the built-in look accumulator, which integrates
     * `input.mouse.dx/dy` once per tick.
     *
     * @param entity Entity to mount on.
     * @param options Eye height and field of view.
     * @returns Nothing.
     */
    firstPerson(entity: number, options?: FirstPersonOptions): void {
      const c = target.camera();
      const look = target.look();
      const eye = options?.eyeHeight ?? 1.7;
      c.mode = 'first-person';
      c.projection = 'perspective';
      c.position.x = f(Transform.x[entity] ?? 0);
      c.position.y = f((Transform.y[entity] ?? 0) + eye);
      c.position.z = f(Transform.z[entity] ?? 0);
      quatFromYawPitch(c.rotation, look.yaw, look.pitch);
      c.target = undefined;
      c.fovYDeg = f(options?.fovYDeg ?? 75);
      c.follow = entity;
      c.armLength = f(0);
      c.offset.x = f(0);
      c.offset.y = f(eye);
      c.offset.z = f(0);
      target.touch();
    },

    /**
     * Put the camera on a spring arm behind an entity.
     *
     * The host owns the arm and its collision; the guest only states the intent.
     * `position` is the orbit pivot and `rotation` the direction the player is
     * looking, so a host with no rig still ends up somewhere sensible.
     *
     * @param entity Entity to follow.
     * @param options Boom length, height offset, field of view and orbit angles.
     * @returns Nothing.
     */
    follow(entity: number, options?: FollowOptions): void {
      const c = target.camera();
      const look = target.look();
      const distance = options?.distance ?? 4;
      const height = options?.height ?? 1.6;
      c.mode = 'third-person';
      c.projection = 'perspective';
      c.position.x = f(Transform.x[entity] ?? 0);
      c.position.y = f((Transform.y[entity] ?? 0) + height);
      c.position.z = f(Transform.z[entity] ?? 0);
      quatFromYawPitch(c.rotation, options?.yaw ?? look.yaw, options?.pitch ?? look.pitch);
      c.target = undefined;
      c.fovYDeg = f(options?.fovYDeg ?? 60);
      c.follow = entity;
      c.armLength = f(distance);
      c.offset.x = f(0);
      c.offset.y = f(height);
      c.offset.z = f(0);
      target.touch();
    },

    /**
     * Place the camera explicitly, detaching it from any entity.
     *
     * @param position Eye position.
     * @param rotation Eye rotation, xyzw.
     * @param fovYDeg Vertical field of view in degrees. Default 60.
     * @returns Nothing.
     */
    set(position: Vec3, rotation: Quat, fovYDeg = 60): void {
      const c = target.camera();
      c.mode = 'free';
      c.projection = 'perspective';
      c.position.x = f(position.x);
      c.position.y = f(position.y);
      c.position.z = f(position.z);
      c.rotation.x = f(rotation.x);
      c.rotation.y = f(rotation.y);
      c.rotation.z = f(rotation.z);
      c.rotation.w = f(rotation.w);
      c.target = undefined;
      c.fovYDeg = f(fovYDeg);
      c.follow = undefined;
      c.armLength = f(0);
      target.touch();
    },

    /**
     * Aim the camera at a world point, overriding its rotation.
     *
     * @param point The point to look at, or `null` to use the rotation again.
     * @returns Nothing.
     */
    lookAt(point: Vec3 | null): void {
      const c = target.camera();
      if (point === null) {
        c.target = undefined;
        target.touch();
        return;
      }
      const t = c.target ?? { x: 0, y: 0, z: 0 };
      t.x = f(point.x);
      t.y = f(point.y);
      t.z = f(point.z);
      c.target = t;
      target.touch();
    },

    /**
     * Accumulated look angles, in radians. Mutate to snap the view.
     *
     * @returns The live look state.
     */
    get look(): { yaw: number; pitch: number; sensitivity: number } {
      return target.look();
    },

    /**
     * The whole camera record, for games that want every knob.
     *
     * @returns The live record. Mutate it; do not replace it.
     */
    get state(): CameraState {
      const c = target.camera();
      target.touch();
      return c;
    },
  };
}

/** Nothing to do after a write: the frame's camera is always returned. */
function noTouch(): void {
  // The frame output points at `rt.camera`; there is nothing to queue.
}

/**
 * The camera facade: writes the frame's camera.
 *
 * @example
 * ```ts
 * import { camera } from 'gameable';
 *
 * camera.firstPerson(player, { eyeHeight: 1.7 });
 * ```
 */
export const camera = createCameraFacade({
  camera: () => requireRuntime().camera,
  look: () => requireRuntime().look,
  touch: noTouch,
});
