// The small matrix and bounds routines every rig backend needs, in ONE place.
//
// There used to be three copies of the affine inverse (`GnmRigBackend`,
// `gnmReference`, `OrlRigBackend`), two of the skin-row packer (`GnmRigBackend`,
// `deform.ts`) and two bounds scans (`OrlRigBackend`, `Character.setBoundingSphere`).
// Every copy agreed when it was written and none of them was tested against the
// others, which is exactly how a rig ends up posed a millimetre away from the mesh
// the decoders were trained on with no error anywhere.
//
// Everything here is ALLOCATION-FREE on the per-frame path: the callers own the
// destination buffers and these routines only write into them.

import type { VertsAABB } from './RigBackend.js';

/**
 * How near zero a determinant has to be before a matrix counts as singular.
 *
 * The rest transforms this is called on are never singular, so the threshold only
 * decides which corrupt pack is reported rather than posed off a NaN.
 */
export const SINGULAR_DETERMINANT = 1e-20;

/**
 * Row-major 4x4 affine inverse (rotation + scale + translation; no projection).
 *
 * @param m Source matrices, flat row-major 4x4, any numeric array.
 * @param off Element index where the source matrix starts (`j * 16`).
 * @param out Destination, flat row-major 4x4.
 * @param oo Element index to write at. Defaults to 0.
 * @param epsilon Determinants smaller than this in absolute value count as singular.
 *   Defaults to {@link SINGULAR_DETERMINANT}.
 * @returns False when the upper-left 3x3 is singular or non-finite, in which case
 *   `out` is left holding the IDENTITY rather than zeros — a caller that reports the
 *   failure and carries on then poses at rest instead of collapsing every vertex onto
 *   a point.
 */
export function invertAffine(
  m: ArrayLike<number>,
  off: number,
  out: Float64Array,
  oo = 0,
  epsilon = SINGULAR_DETERMINANT,
): boolean {
  const a = m[off];
  const b = m[off + 1];
  const c = m[off + 2];
  const d = m[off + 4];
  const e = m[off + 5];
  const f = m[off + 6];
  const g = m[off + 8];
  const h = m[off + 9];
  const i = m[off + 10];
  const det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
  if (!Number.isFinite(det) || Math.abs(det) < epsilon) {
    identityAffine(out, oo);
    return false;
  }
  const s = 1 / det;
  const i00 = (e * i - f * h) * s;
  const i01 = (c * h - b * i) * s;
  const i02 = (b * f - c * e) * s;
  const i10 = (f * g - d * i) * s;
  const i11 = (a * i - c * g) * s;
  const i12 = (c * d - a * f) * s;
  const i20 = (d * h - e * g) * s;
  const i21 = (b * g - a * h) * s;
  const i22 = (a * e - b * d) * s;
  const tx = m[off + 3];
  const ty = m[off + 7];
  const tz = m[off + 11];
  out[oo] = i00;
  out[oo + 1] = i01;
  out[oo + 2] = i02;
  out[oo + 3] = -(i00 * tx + i01 * ty + i02 * tz);
  out[oo + 4] = i10;
  out[oo + 5] = i11;
  out[oo + 6] = i12;
  out[oo + 7] = -(i10 * tx + i11 * ty + i12 * tz);
  out[oo + 8] = i20;
  out[oo + 9] = i21;
  out[oo + 10] = i22;
  out[oo + 11] = -(i20 * tx + i21 * ty + i22 * tz);
  out[oo + 12] = 0;
  out[oo + 13] = 0;
  out[oo + 14] = 0;
  out[oo + 15] = 1;
  return true;
}

/**
 * Write the identity into one row-major 4x4 slot.
 *
 * @param out Destination matrices, flat.
 * @param oo Element index to write at.
 */
export function identityAffine(out: Float64Array, oo = 0): void {
  for (let k = 0; k < 16; k++) out[oo + k] = 0;
  out[oo] = 1;
  out[oo + 5] = 1;
  out[oo + 10] = 1;
  out[oo + 15] = 1;
}

/**
 * Pack row-major 4x4 skin matrices into the 12-float rows a rig shader binds.
 *
 * Both rig backends upload the skin matrices as three `vec4` rows per joint — the
 * bottom row is always `[0, 0, 0, 1]` and would waste a quarter of a uniform that is
 * already 42 KB on an 870-joint DNA.
 *
 * @param skin `joints * 16` row-major matrices.
 * @param joints How many joints to pack.
 * @param out `joints * 12` destination, written in place.
 * @returns True when any float in `out` actually changed, so the caller can skip the
 *   uniform upload on an idle frame.
 */
export function packSkinRows(skin: ArrayLike<number>, joints: number, out: Float32Array): boolean {
  let changed = false;
  for (let j = 0; j < joints; j++) {
    const b = j * 16;
    const r = j * 12;
    for (let row = 0; row < 3; row++) {
      for (let c = 0; c < 4; c++) {
        const at = r + row * 4 + c;
        // Compared AFTER the store, so the comparison is between two f32s: a double
        // that rounds to the same float is not a change the GPU could ever see, and
        // rounding it here costs nothing the store did not already do.
        const previous = out[at];
        out[at] = skin[b + row * 4 + c];
        if (out[at] !== previous) changed = true;
      }
    }
  }
  return changed;
}

/** A bounds scan in progress: six running extrema, reused across vertex arrays. */
export interface MutableAabb {
  minX: number;
  minY: number;
  minZ: number;
  maxX: number;
  maxY: number;
  maxZ: number;
}

/**
 * An empty bounds accumulator, ready for {@link growAabb}.
 *
 * @returns Infinities in both directions, so the first vertex sets all six.
 */
export function emptyAabb(): MutableAabb {
  return {
    minX: Infinity,
    minY: Infinity,
    minZ: Infinity,
    maxX: -Infinity,
    maxY: -Infinity,
    maxZ: -Infinity,
  };
}

/**
 * Widen `box` to contain every vertex of `verts`.
 *
 * @param verts Vertex positions as flat xyz triples, in whatever space they are in.
 * @param box The accumulator, mutated in place — several branches of one character
 *   union into the same one.
 * @returns The same `box`.
 */
export function growAabb(verts: ArrayLike<number>, box: MutableAabb): MutableAabb {
  for (let i = 0; i + 2 < verts.length; i += 3) {
    const x = verts[i];
    const y = verts[i + 1];
    const z = verts[i + 2];
    if (x < box.minX) box.minX = x;
    if (y < box.minY) box.minY = y;
    if (z < box.minZ) box.minZ = z;
    if (x > box.maxX) box.maxX = x;
    if (y > box.maxY) box.maxY = y;
    if (z > box.maxZ) box.maxZ = z;
  }
  return box;
}

/**
 * Axis-aligned bounds of a packed xyz array.
 *
 * @param verts Vertex positions as xyz triples, in whatever space they are in.
 * @returns The componentwise min and max. An empty input gives an all-zero box
 *   rather than the infinities the scan would otherwise leave behind.
 */
export function aabbOf(verts: ArrayLike<number>): VertsAABB {
  if (verts.length === 0) return { min: [0, 0, 0], max: [0, 0, 0] };
  const box = growAabb(verts, emptyAabb());
  return { min: [box.minX, box.minY, box.minZ], max: [box.maxX, box.maxY, box.maxZ] };
}
