/**
 * Copies of the server adapter's pooled one-shots and per-player camera.
 *
 * The adapter rewrites its transient commands and its camera copy on every
 * step, and a view may cover several steps, so the replicator copies what it
 * forwards while the step is current (the reliable path's accepted
 * allocation).
 */
import type { CameraState, Command, Quat, Vec3 } from '@gameable/sdk';

/**
 * @param v A vector the adapter owns.
 * @returns A copy.
 */
const v3 = (v: Vec3): Vec3 => ({ x: v.x, y: v.y, z: v.z });

/**
 * @param q A quaternion the adapter owns.
 * @returns A copy.
 */
const q4 = (q: Quat): Quat => ({ x: q.x, y: q.y, z: q.z, w: q.w });

/**
 * @param command One of the adapter's transient commands (`say`,
 *   `play-sound`, `stop-sound`, `set-listener`, `load-asset`).
 * @returns A copy that aliases nothing the adapter reuses, or null for any other tag.
 */
export function copyTransient(command: Command): Command | null {
  switch (command.tag) {
    case 'say':
    case 'stop-sound':
    case 'load-asset':
      return { tag: command.tag, val: { ...command.val } } as Command;
    case 'play-sound': {
      const { position, ...rest } = command.val;
      return {
        tag: 'play-sound',
        val: position === undefined ? rest : { ...rest, position: v3(position) },
      };
    }
    case 'set-listener':
      return {
        tag: 'set-listener',
        val: {
          position: v3(command.val.position),
          rotation: q4(command.val.rotation),
          velocity: v3(command.val.velocity),
        },
      };
    default:
      return null;
  }
}

/**
 * @param command A transient command.
 * @returns The entity it is attached to, or undefined when it is not.
 */
export function transientEntity(command: Command): number | undefined {
  if (command.tag === 'say') return command.val.entity;
  if (command.tag === 'play-sound') return command.val.entity;
  return undefined;
}

/**
 * @param camera A camera the adapter owns.
 * @returns A deep copy.
 */
export function copyCamera(camera: CameraState): CameraState {
  return {
    ...camera,
    position: v3(camera.position),
    rotation: q4(camera.rotation),
    target: camera.target === undefined ? undefined : v3(camera.target),
    offset: v3(camera.offset),
  };
}

/**
 * @param a A vector, or undefined.
 * @param b Another.
 * @returns True when both are undefined or have the same lanes.
 */
function sameVec(a: Vec3 | undefined, b: Vec3 | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  return a.x === b.x && a.y === b.y && a.z === b.z;
}

/**
 * Field-by-field camera equality; allocates nothing.
 *
 * @param a The camera last sent, or undefined.
 * @param b The camera now.
 * @returns True when nothing a client sees differs.
 */
export function sameCamera(a: CameraState | undefined, b: CameraState): boolean {
  if (a === undefined) return false;
  const ar = a.rotation;
  const br = b.rotation;
  return (
    a.mode === b.mode &&
    a.projection === b.projection &&
    sameVec(a.position, b.position) &&
    ar.x === br.x &&
    ar.y === br.y &&
    ar.z === br.z &&
    ar.w === br.w &&
    sameVec(a.target, b.target) &&
    a.fovYDeg === b.fovYDeg &&
    a.near === b.near &&
    a.far === b.far &&
    a.follow === b.follow &&
    a.armLength === b.armLength &&
    sameVec(a.offset, b.offset)
  );
}
