/**
 * The synthetic producer: raw WGSL that writes gaussians straight into three's storage
 * buffers, ported from spike S2.
 *
 * It exists to stand in for a character lift in the benchmark and in the viewer's dynamic
 * mode — same buffers, same packing, same per-frame cost shape, no ONNX and no rig. If this
 * runs clean, a real producer's only remaining problem is its own maths.
 *
 * The packing must match `createStorageBuffers` in `GaussianSplat.js:629-690` exactly; see
 * the table in `src/backendBuffers.ts`. The six covariance floats are in
 * `GaussianSplatUtils.writeCovariance` order — `c00, c01, c02, c11, c12, c22` — and
 * `packages/splat/src/bench/covariance.test.ts` proves this shader's formulation agrees with
 * that function to 1e-5 relative.
 */

/** Workgroup size. Matches three's own `WORKGROUP_SIZE`, so dispatch maths is shared. */
export const ANIMATE_WORKGROUP_SIZE = 256;

/** Bytes in the `Params` uniform: `time: f32, count: u32, boxHalf: f32, spin: f32`. */
export const ANIMATE_PARAMS_BYTES = 16;

/** The compute shader. Entry point `main`, bindings 0-3 storage, binding 4 uniform. */
export const ANIMATE_WGSL = /* wgsl */ `
struct Params {
  time    : f32,
  count   : u32,
  boxHalf : f32,
  spin    : f32,
};

@group(0) @binding(0) var<storage, read_write> centers : array<vec4<f32>>;
@group(0) @binding(1) var<storage, read_write> covA    : array<vec4<f32>>;
@group(0) @binding(2) var<storage, read_write> covB    : array<vec4<f32>>;
@group(0) @binding(3) var<storage, read_write> colors  : array<u32>;
@group(0) @binding(4) var<uniform>             params  : Params;

fn pcg(vIn : u32) -> u32 {
  var v = vIn * 747796405u + 2891336453u;
  let w = ((v >> ((v >> 28u) + 4u)) ^ v) * 277803737u;
  return (w >> 22u) ^ w;
}

fn rnd(seed : u32) -> f32 {
  return f32(pcg(seed)) * 2.3283064365386963e-10; // /2^32
}

@compute @workgroup_size(${String(ANIMATE_WORKGROUP_SIZE)})
fn main(@builtin(global_invocation_id) gid : vec3<u32>) {
  let i = gid.x;
  if (i >= params.count) { return; }

  let t = params.time;

  // ---- stable per-splat random constants -------------------------------------------------
  let r0 = rnd(i * 3u + 0u);
  let r1 = rnd(i * 3u + 1u);
  let r2 = rnd(i * 3u + 2u);
  let r3 = rnd(i * 7u + 11u);
  let r4 = rnd(i * 7u + 13u);
  let r5 = rnd(i * 7u + 17u);

  let h = params.boxHalf;
  let base = vec3<f32>((r0 - 0.5) * 2.0 * h,
                       (r1 - 0.5) * 1.2 * h,
                       (r2 - 0.5) * 2.0 * h);

  // ---- sine-warped centers ---------------------------------------------------------------
  let phase = (r3 + r4) * 6.2831853;
  let warp = vec3<f32>(
    sin(t * 0.9 + base.z * 0.8 + phase) * 0.35,
    sin(t * 1.4 + base.x * 0.7 + phase) * 0.45 + sin(t * 0.31 + base.y) * 0.15,
    cos(t * 1.1 + base.y * 0.9 + phase) * 0.35
  );
  centers[i] = vec4<f32>(base + warp, 1.0);

  // ---- slowly rotating anisotropic covariance --------------------------------------------
  // Rodrigues rotation of a fixed anisotropic scale triple.
  var axis = normalize(vec3<f32>(r3 - 0.5, r4 - 0.5, r5 - 0.5) + vec3<f32>(1e-4, 0.0, 0.0));
  let ang = t * params.spin * (0.4 + r5) + phase;
  let c = cos(ang);
  let s = sin(ang);
  let C = 1.0 - c;
  let x = axis.x; let y = axis.y; let z = axis.z;

  // columns of R
  let col0 = vec3<f32>(c + x*x*C,      y*x*C + z*s,  z*x*C - y*s);
  let col1 = vec3<f32>(x*y*C - z*s,    c + y*y*C,    z*y*C + x*s);
  let col2 = vec3<f32>(x*z*C + y*s,    y*z*C - x*s,  c + z*z*C);

  // anisotropic scales in metres, ~4:1 ratio, gently breathing
  let breathe = 1.0 + 0.25 * sin(t * 1.7 + phase);
  let sx = (0.010 + 0.030 * r0) * breathe;
  let sy = (0.008 + 0.008 * r1) * breathe;
  let sz = (0.008 + 0.008 * r2) * breathe;
  let d = vec3<f32>(sx*sx, sy*sy, sz*sz);

  // Sigma = R * diag(d) * R^T  ==  sum_k d_k * col_k (x) col_k
  let c00 = d.x*col0.x*col0.x + d.y*col1.x*col1.x + d.z*col2.x*col2.x;
  let c01 = d.x*col0.x*col0.y + d.y*col1.x*col1.y + d.z*col2.x*col2.y;
  let c02 = d.x*col0.x*col0.z + d.y*col1.x*col1.z + d.z*col2.x*col2.z;
  let c11 = d.x*col0.y*col0.y + d.y*col1.y*col1.y + d.z*col2.y*col2.y;
  let c12 = d.x*col0.y*col0.z + d.y*col1.y*col1.z + d.z*col2.y*col2.z;
  let c22 = d.x*col0.z*col0.z + d.y*col1.z*col1.z + d.z*col2.z*col2.z;

  covA[i] = vec4<f32>(c00, c01, c02, c11);
  covB[i] = vec4<f32>(c12, c22, 0.0, 0.0);

  // ---- rgba8 colour ----------------------------------------------------------------------
  let hue = fract(r0 + t * 0.04);
  let rgb = clamp(
    0.55 + 0.45 * cos(6.2831853 * (hue + vec3<f32>(0.0, 0.33, 0.67))),
    vec3<f32>(0.0), vec3<f32>(1.0));
  let alpha = 0.55 + 0.35 * r4;
  colors[i] = pack4x8unorm(vec4<f32>(rgb, alpha));
}
`;

/**
 * The CPU twin of the shader's covariance maths, for the reference test.
 *
 * Same expressions, same order, in double precision. If this and
 * `GaussianSplatUtils.writeCovariance` agree, the shader's packing is right.
 *
 * @param out A six-element target: `c00, c01, c02, c11, c12, c22`.
 * @param axis Rotation axis, not necessarily normalised.
 * @param angle Rotation angle in radians.
 * @param scale Per-axis standard deviations.
 * @returns `out`.
 *
 * @example
 * ```ts
 * const out = new Float64Array(6);
 * covarianceFromAxisAngle(out, [0, 1, 0], Math.PI / 4, [0.02, 0.01, 0.01]);
 * ```
 */
export function covarianceFromAxisAngle(
  out: Float64Array | Float32Array | number[],
  axis: readonly [number, number, number],
  angle: number,
  scale: readonly [number, number, number],
): typeof out {
  const n = Math.hypot(axis[0], axis[1], axis[2]);
  const x = axis[0] / n;
  const y = axis[1] / n;
  const z = axis[2] / n;
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const C = 1 - c;

  const col0 = [c + x * x * C, y * x * C + z * s, z * x * C - y * s] as const;
  const col1 = [x * y * C - z * s, c + y * y * C, z * y * C + x * s] as const;
  const col2 = [x * z * C + y * s, y * z * C - x * s, c + z * z * C] as const;

  const d0 = scale[0] * scale[0];
  const d1 = scale[1] * scale[1];
  const d2 = scale[2] * scale[2];

  /**
   * One entry of `R diag(d) Rᵀ`.
   *
   * @param a Row index.
   * @param b Column index.
   * @returns The covariance entry.
   */
  const e = (a: number, b: number): number =>
    d0 * col0[a] * col0[b] + d1 * col1[a] * col1[b] + d2 * col2[a] * col2[b];

  out[0] = e(0, 0);
  out[1] = e(0, 1);
  out[2] = e(0, 2);
  out[3] = e(1, 1);
  out[4] = e(1, 2);
  out[5] = e(2, 2);
  return out;
}
