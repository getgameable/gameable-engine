/**
 * Field-by-field copies into owned vectors and arrays, so nothing the server
 * keeps aliases an object the guest will reuse next tick.
 */
import type { Quat, Vec3 } from '@gameable/sdk';

/**
 * Copy a vector into an owned one.
 *
 * @param target The owned vector.
 * @param source The guest's vector.
 * @returns `target`.
 */
export function copyVec(target: Vec3, source: Vec3): Vec3 {
  target.x = source.x;
  target.y = source.y;
  target.z = source.z;
  return target;
}

/**
 * Copy a quaternion into an owned one.
 *
 * @param target The owned quaternion.
 * @param source The guest's quaternion.
 * @returns `target`.
 */
export function copyQuat(target: Quat, source: Quat): Quat {
  target.x = source.x;
  target.y = source.y;
  target.z = source.z;
  target.w = source.w;
  return target;
}

/**
 * Copy a list into an owned array, reusing its storage.
 *
 * @param target The owned array.
 * @param source The guest's list.
 * @returns `target`.
 */
export function copyList<T>(target: T[], source: ArrayLike<T>): T[] {
  target.length = source.length;
  for (let i = 0; i < source.length; i += 1) target[i] = source[i];
  return target;
}
