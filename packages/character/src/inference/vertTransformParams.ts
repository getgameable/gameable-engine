// Pure packing of the vert_transform.wgsl uniform block. Split out of GpuLifter
// so the byte layout is unit-testable: a silently wrong offset here anchors the
// whole splat field to the wrong place with no error anywhere.
//
// Ported from aos-threejs-poc/src/ogs/inference/vertTransformParams.ts @ cdd63b10
//
// std140-ish layout (80 B), matching `struct Params` in vert_transform.wgsl:
//   0  : vec4  lin0 (xyz = ROW 0 of the 3x3)
//   16 : vec4  lin1 (row 1)
//   32 : vec4  lin2 (row 2)
//   48 : vec4  offset (xyz used)
//   64 : vec4<u32> n  (x = numVerts, y = useCorr)
//
// The linear part is a full 3x3, not the scalar it used to be, because the
// ORL→checkpoint mapping carries a ROTATION as well as a scale: TexAvatars bakes
// its training geometry as `100 · [GlobalRigid(t) ∘ rig2mesh_full(rig)]`, and for
// isaac that rotation (3.45°) was baked into the shipped rig2mesh ONNX as
// `100·R0`. The exact rig emits neither, so a scalar could not express the
// difference — and the per-vertex `corr` cannot either: it makes the anchor pose
// exact and leaves every DISPLACEMENT rotated wrong, by 2·sin(θ/2) ≈ 6% of its
// magnitude. Rows, not columns: the transform is applied as a row-vector product
// `v' = v·M` (v.x·row0 + v.y·row1 + v.z·row2), matching the server's `v @ lin`.

export const VERT_TRANSFORM_PARAMS_BYTES = 80;

/**
 * Read past the end as 0. `ArrayLike<number>` indexes as `number`, so a bounds check
 * is the only thing that makes a short input safe — and a short `lin` here is a
 * partially-written transform, which anchors the whole splat field wrong.
 *
 * @param values The source array, which may be shorter than the caller assumes.
 * @param index The element to read.
 * @returns `values[index]`, or 0 when `index` is past the end.
 */
function at(values: ArrayLike<number>, index: number): number {
  return index < values.length ? values[index] : 0;
}

/**
 * Pack the `struct Params` uniform block for `vert_transform.wgsl`, in the 80-byte layout
 * documented at the top of this file.
 *
 * @param lin The 3x3 linear part of the rig-to-checkpoint map, 9 floats ROW-major; rows land
 *   in the `lin0`/`lin1`/`lin2` vec4s at bytes 0, 16 and 32.
 * @param offset The translation of that map, xyz written to bytes 48..59.
 * @param numVerts The vertex count the shader bounds its dispatch with, at byte 64.
 * @param useCorr Whether the shader adds the per-vertex `corr` residual; written as 1 or 0 at
 *   byte 68.
 * @returns A fresh 80-byte `ArrayBuffer` ready to hand to `queue.writeBuffer`.
 */
export function packVertTransformParams(
  lin: ArrayLike<number>, // 9 floats, ROW-major
  offset: ArrayLike<number>,
  numVerts: number,
  useCorr: boolean,
): ArrayBuffer {
  const buf = new ArrayBuffer(VERT_TRANSFORM_PARAMS_BYTES);
  const f = new Float32Array(buf);
  const u = new Uint32Array(buf);
  for (let r = 0; r < 3; r++) {
    f[r * 4 + 0] = at(lin, r * 3 + 0);
    f[r * 4 + 1] = at(lin, r * 3 + 1);
    f[r * 4 + 2] = at(lin, r * 3 + 2);
  }
  f[12] = at(offset, 0);
  f[13] = at(offset, 1);
  f[14] = at(offset, 2);
  u[16] = numVerts;
  u[17] = useCorr ? 1 : 0;
  return buf;
}
