// Shared value types for the lift chain.
//
// Ported from aos-threejs-poc/src/ogs/inference/lift.ts @ cdd63b10 (the type
// declarations only — the CPU `GaussianLifter` does not come across: the WGSL lift
// is the only lift in this package, and a second implementation of the same maths
// can only disagree with the numeric reference).

/**
 * A `geom_uv` / `color_uv` input to the lifter: either a CPU `Float32Array` (the
 * decoder output was read back) or a gpu-buffer wrapper — the shared-device path,
 * where the output stayed on ORT's device and the lift `copyBufferToBuffer`s it
 * with no CPU round-trip.
 */
export type LiftInput = Float32Array | { gpuBuffer: GPUBuffer; byteLength: number };

/**
 * A UV-space opacity mask (occlusion map): one grayscale value per texel,
 * row-major (`y*width + x`), 0 = hidden, 1 = kept. Sampled at each gaussian's UV
 * during the lift to cull occluded splats — the splat analogue of an alpha-tested
 * mask, but it removes the gaussian entirely (fewer splats, cheaper render) rather
 * than fading it. Resolution is independent of `uv_res`; the mask is bilinearly
 * sampled.
 */
export interface OpacityMask {
  data: Float32Array;
  width: number;
  height: number;
}

/**
 * Bilinearly sample an `OpacityMask` at normalized UV in `[0,1]^2`, clamping
 * out-of-range UVs to the edge. Pure, so the GPU cull has a CPU reference.
 *
 * @param mask The occlusion map to read; a zero-sized mask samples as fully kept.
 * @param u Horizontal texel coordinate, normalized to `[0,1]` across the width.
 * @param v Vertical texel coordinate, normalized to `[0,1]` across the height.
 * @returns The interpolated mask value, 0 = hidden through 1 = kept.
 */
export function sampleMaskBilinear(mask: OpacityMask, u: number, v: number): number {
  const { data, width: W, height: H } = mask;
  if (W <= 0 || H <= 0) return 1;
  const cu = u < 0 ? 0 : u > 1 ? 1 : u;
  const cv = v < 0 ? 0 : v > 1 ? 1 : v;
  const fx = cu * (W - 1);
  const fy = cv * (H - 1);
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const x1 = Math.min(x0 + 1, W - 1);
  const y1 = Math.min(y0 + 1, H - 1);
  const tx = fx - x0;
  const ty = fy - y0;
  const v00 = data[y0 * W + x0];
  const v10 = data[y0 * W + x1];
  const v01 = data[y1 * W + x0];
  const v11 = data[y1 * W + x1];
  const top = v00 + (v10 - v00) * tx;
  const bot = v01 + (v11 - v01) * tx;
  return top + (bot - top) * ty;
}
