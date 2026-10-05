/**
 * Material values copied into storage the server owns, and compared, so a
 * record never aliases the object the guest will reuse next tick.
 */
import type { MaterialValue } from '@gameable/sdk';

import { copyVec } from './copies';

/** One owned value per `MaterialValue` variant. */
export type MaterialSlots = { [K in MaterialValue['tag']]: Extract<MaterialValue, { tag: K }> };

/** @returns A fresh set of owned values, one per variant. */
export function materialSlots(): MaterialSlots {
  return {
    scalar: { tag: 'scalar', val: 0 },
    boolean: { tag: 'boolean', val: false },
    color: { tag: 'color', val: { r: 0, g: 0, b: 0, a: 1 } },
    vector: { tag: 'vector', val: { x: 0, y: 0, z: 0 } },
    texture: { tag: 'texture', val: 0 },
  };
}

/**
 * Copy a value into the owned slot of its variant.
 *
 * @param slots The owned values.
 * @param value The guest's value.
 * @returns The owned slot now holding it.
 */
export function writeMaterial(slots: MaterialSlots, value: MaterialValue): MaterialValue {
  switch (value.tag) {
    case 'scalar':
      slots.scalar.val = value.val;
      return slots.scalar;
    case 'boolean':
      slots.boolean.val = value.val;
      return slots.boolean;
    case 'texture':
      slots.texture.val = value.val;
      return slots.texture;
    case 'color': {
      const c = slots.color.val;
      c.r = value.val.r;
      c.g = value.val.g;
      c.b = value.val.b;
      c.a = value.val.a;
      return slots.color;
    }
    case 'vector':
      copyVec(slots.vector.val, value.val);
      return slots.vector;
  }
}

/**
 * @param a One value.
 * @param b Another.
 * @returns True when both are the same variant holding the same numbers.
 */
export function materialEquals(a: MaterialValue, b: MaterialValue): boolean {
  switch (a.tag) {
    case 'scalar':
    case 'boolean':
    case 'texture':
      return b.tag === a.tag && b.val === a.val;
    case 'color':
      return (
        b.tag === 'color' &&
        b.val.r === a.val.r &&
        b.val.g === a.val.g &&
        b.val.b === a.val.b &&
        b.val.a === a.val.a
      );
    case 'vector':
      return (
        b.tag === 'vector' && b.val.x === a.val.x && b.val.y === a.val.y && b.val.z === a.val.z
      );
  }
}
