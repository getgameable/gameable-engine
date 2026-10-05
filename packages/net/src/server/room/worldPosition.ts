/**
 * An entity's world position from the record's local transforms.
 */
import type { EntityRecord, WorldRecord } from '@gameable/wasm-host/server';

/** How deep a parent chain is followed before it is taken for a cycle. */
const MAX_DEPTH = 32;

/**
 * Compose `record`'s position up its parent chain: at each parent, scale,
 * rotate by the parent's quaternion, then add its position. A record keeps
 * the guest's local transform, so a player seated on a vehicle is near the
 * origin in its own record. Allocates nothing.
 *
 * @param world The world record.
 * @param record The entity's record.
 * @param out Three lanes the world position is written into.
 * @returns `out`.
 *
 * @example
 * ```ts
 * import { worldPosition } from 'gameable/net/server';
 *
 * const at = worldPosition(adapter.world, seat, new Float32Array(3));
 * ```
 */
export function worldPosition(world: WorldRecord, record: EntityRecord, out: Float32Array): Float32Array {
  let x = record.position[0];
  let y = record.position[1];
  let z = record.position[2];
  let node = record;
  for (let depth = 0; depth < MAX_DEPTH && node.parent !== undefined; depth += 1) {
    const parent = world.get(node.parent);
    if (parent === undefined) break;
    const s = parent.scale;
    x *= s[0];
    y *= s[1];
    z *= s[2];
    const q = parent.rotation;
    const qx = q[0];
    const qy = q[1];
    const qz = q[2];
    const qw = q[3];
    // v' = v + 2w(q x v) + 2 q x (q x v)
    const tx = 2 * (qy * z - qz * y);
    const ty = 2 * (qz * x - qx * z);
    const tz = 2 * (qx * y - qy * x);
    const rx = x + qw * tx + (qy * tz - qz * ty);
    const ry = y + qw * ty + (qz * tx - qx * tz);
    const rz = z + qw * tz + (qx * ty - qy * tx);
    x = rx + parent.position[0];
    y = ry + parent.position[1];
    z = rz + parent.position[2];
    node = parent;
  }
  out[0] = x;
  out[1] = y;
  out[2] = z;
  return out;
}
