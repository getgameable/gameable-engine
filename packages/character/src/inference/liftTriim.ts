// The texel-validity fold, split out of GpuLifter so it is unit-testable: losing
// this mask is silent — invalid texels would lift as if they were surface.
//
// Ported from aos-threejs-poc/src/ogs/inference/liftTriim.ts @ cdd63b10

/**
 * `triim` with the mesh's `valid` folded in (invalid texel -> -1).
 *
 * `lift_pass1.wgsl` reads validity out of this, which is what holds it to 8
 * storage buffers — one more than that is past WebGPU's default limit and refuses
 * a stock adapter the GPU lift entirely.
 *
 * @param triim Per-texel face id from the decoder's triangle-index map, one entry per texel;
 *   -1 already means "no face here".
 * @param valid Per-texel validity flag of the same length; 0 marks a texel the mesh does not
 *   cover.
 * @returns A new `Int32Array` of the same length, with every invalid texel forced to -1.
 */
export function validityMaskedTriim(triim: Int32Array, valid: Uint8Array): Int32Array {
  return Int32Array.from(triim, (faceId, texel) => (valid[texel] ? faceId : -1));
}
