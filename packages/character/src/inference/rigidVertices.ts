// One rigid transform over a branch's vertices.
//
// The lift builds each gaussian's rotation from the local surface frame, so moving
// the verts moves the splats with them — a rigid drive needs no rotation pass and no
// re-decode. Shared by the branch mount and the part drive's hair, which would
// otherwise carry two copies of the same loop.
//
// Ported from aos-threejs-poc/src/ogs/inference/rigidVertices.js @ cdd63b10

/** A three.js `Matrix4`, or a bare column-major `elements` array. */
export type Matrix4Like = { elements: ArrayLike<number> } | ArrayLike<number>;

/**
 * `out[i] = matrix · neutral[i]`, in three's column-major `elements` order.
 *
 * @param neutral Flat xyz triples in the branch's neutral pose, metres.
 * @param matrix The rigid transform to apply — a `Matrix4` or its bare column-major elements.
 * @param out Destination for the transformed flat xyz triples; must be at least as long as
 *   `neutral`, and may be `neutral` itself since each triple is read before it is written.
 * @returns `out`, so callers can hand the result straight on.
 */
export function transformVertices(
  neutral: Float32Array,
  matrix: Matrix4Like,
  out: Float32Array,
): Float32Array {
  const m = (matrix as { elements?: ArrayLike<number> }).elements ?? (matrix as ArrayLike<number>);
  for (let i = 0; i < neutral.length; i += 3) {
    const x = neutral[i];
    const y = neutral[i + 1];
    const z = neutral[i + 2];
    out[i] = m[0] * x + m[4] * y + m[8] * z + m[12];
    out[i + 1] = m[1] * x + m[5] * y + m[9] * z + m[13];
    out[i + 2] = m[2] * x + m[6] * y + m[10] * z + m[14];
  }
  return out;
}
