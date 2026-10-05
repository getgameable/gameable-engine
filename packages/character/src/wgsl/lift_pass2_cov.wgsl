// Pass 2: bilinear-sample pass 1's per-texel (pos, cov, opacity) at an N×N sample
// grid, eigendecompose the sampled covariance, derive (scale, quat), filter by
// bilinear validity, then RECOMPOSE the covariance in scene space and write it
// straight into the splat sink's storage buffers at this branch's slot offset.
//
// Rewritten from aos-threejs-poc/src/ogs/inference/wgsl/lift_pass2.wgsl @ cdd63b10.
// What changed and why:
//
//  * THE ATOMIC COMPACTION IS GONE. Each texel owns a FIXED slot
//    (`params.slot_offset + s`), so index -> splat never changes across frames and
//    three's CountingSort keeps its map valid. A compacted order reshuffles every
//    lift and tears the sort during camera motion. Culled texels write opacity 0
//    rather than being dropped, so the branch's slot count is constant.
//  * THE QUANTISED PACKING IS GONE. The POC emitted its renderer's packed words —
//    fp16 centres, a log-encoded scale and an octahedral quaternion — and read them
//    back to the CPU. three stores the covariance directly, so that whole round trip
//    (eigendecompose -> quat -> quantise -> shader rebuild) becomes recomposing Σ
//    here, and nothing quantises anything any more.
//  * WORLD SCALE AND ROTATION ARE BAKED IN. The POC placed the splats by scaling
//    and rotating the SplatMesh; there is no per-branch mesh here, so the lift
//    writes scene-space centres and covariances. The plücker camera inverts the
//    same rotation (see ../inference/plucker.ts), exactly as the POC does.
//
// WHAT DID NOT CHANGE: every clamp. The eigendecomposition, `sqrt(max(1e-12, λ))`,
// the non-finite drop, the bilinear-validity threshold and the opacity-mask cull
// are the POC's, line for line — they are what makes this lift the same model.
//
// OUTPUT LAYOUT — three r186 `createStorageBuffers`, see ../splatSink.ts:
//   center[i]       vec4<f32>  xyz = centre (scene metres), w = 1
//   covariance_a[i] vec4<f32>  (c00, c01, c02, c11)
//   covariance_b[i] vec4<f32>  (c12, c22, 0, 0)
//   color[i]        u32        pack4x8unorm(r, g, b, opacity)
// The six covariance terms are `GaussianSplatUtils.writeCovariance` order.

struct Dims {
  H:  u32,
  W:  u32,
  HW: u32,
  N:  u32,  // sample_res; equals H in this build
}

// Opacity mask (occlusion map). enabled=0 → the pass-2 cull is a no-op (the
// data buffer is then a 1×1 dummy). width/height index mask_data (row-major);
// threshold is the mask value below which a sampled gaussian is dropped.
struct MaskParams {
  enabled:   u32,
  width:     u32,
  height:    u32,
  threshold: f32,
}

// Per-branch placement, written once at init.
//
// `world_rot` is the bundle's `world_rotation` as a quaternion (wxyz), applied to
// centres and to the covariance basis; `world_scale` is its cm→m factor, folded
// into the covariance as scale² because Σ = M·Mᵀ. Both are baked in rather than
// left on an Object3D because every branch of every character shares ONE splat
// object, which therefore cannot carry a per-branch transform.
struct Placement {
  slot_offset:  u32,
  slot_count:   u32,
  _pad0:        u32,
  _pad1:        u32,
  world_rot:    vec4<f32>,   // (w, x, y, z)
  world_offset: vec4<f32>,   // xyz used, scene metres
  world_scale:  f32,
  _pad2:        f32,
  _pad3:        f32,
  _pad4:        f32,
}

@group(0) @binding(0) var<storage, read>       pass1_out:    array<f32>;  // HW * 10
@group(0) @binding(1) var<storage, read>       color_uv:     array<f32>;  // 3 * HW
@group(0) @binding(2) var<storage, read>       valid:        array<u32>;  // HW
@group(0) @binding(3) var<uniform>             dims:         Dims;
@group(0) @binding(4) var<uniform>             mask_params:  MaskParams;
@group(0) @binding(5) var<storage, read>       mask_data:    array<f32>;  // width * height
@group(0) @binding(6) var<uniform>             place:        Placement;

@group(1) @binding(0) var<storage, read_write> center:       array<vec4<f32>>;
@group(1) @binding(1) var<storage, read_write> covariance_a: array<vec4<f32>>;
@group(1) @binding(2) var<storage, read_write> covariance_b: array<vec4<f32>>;
@group(1) @binding(3) var<storage, read_write> color:        array<u32>;

struct EigResult {
  eigs: vec3<f32>,
  v0: vec3<f32>,
  v1: vec3<f32>,
  v2: vec3<f32>,
}

// Cyclic Jacobi eigendecomposition of a 3×3 symmetric matrix.
fn eig_decomp_3(a00: f32, a01: f32, a02: f32,
                a11: f32, a12: f32, a22: f32) -> EigResult {
  var m00 = a00; var m01 = a01; var m02 = a02;
  var m11 = a11; var m12 = a12;
  var m22 = a22;
  var v00 = 1.0; var v01 = 0.0; var v02 = 0.0;
  var v10 = 0.0; var v11 = 1.0; var v12 = 0.0;
  var v20 = 0.0; var v21 = 0.0; var v22 = 1.0;

  for (var iter: i32 = 0; iter < 30; iter = iter + 1) {
    let diag_mag = abs(m00) + abs(m11) + abs(m22) + 1e-30;
    let o01 = abs(m01);
    let o02 = abs(m02);
    let o12 = abs(m12);
    if (o01 + o02 + o12 < 1e-12 * diag_mag) { break; }

    // Pick largest off-diagonal as the Jacobi rotation pivot.
    var pivot: i32; // 0 = (0,1), 1 = (0,2), 2 = (1,2)
    var app: f32; var aqq: f32; var apq: f32;
    if (o01 >= o02 && o01 >= o12) {
      pivot = 0; app = m00; aqq = m11; apq = m01;
    } else if (o02 >= o12) {
      pivot = 1; app = m00; aqq = m22; apq = m02;
    } else {
      pivot = 2; app = m11; aqq = m22; apq = m12;
    }
    if (apq == 0.0) { break; }

    let theta = (aqq - app) / (2.0 * apq);
    let sgn = select(-1.0, 1.0, theta >= 0.0);
    let t = sgn / (abs(theta) + sqrt(1.0 + theta * theta));
    let c = 1.0 / sqrt(1.0 + t * t);
    let s = t * c;

    if (pivot == 0) {
      // rotate (0,1)
      let new00 = c * c * m00 - 2.0 * s * c * m01 + s * s * m11;
      let new11 = s * s * m00 + 2.0 * s * c * m01 + c * c * m11;
      let new02 = c * m02 - s * m12;
      let new12 = s * m02 + c * m12;
      m00 = new00; m11 = new11; m01 = 0.0;
      m02 = new02; m12 = new12;
      let nv00 = c * v00 - s * v01; let nv01 = s * v00 + c * v01;
      let nv10 = c * v10 - s * v11; let nv11 = s * v10 + c * v11;
      let nv20 = c * v20 - s * v21; let nv21 = s * v20 + c * v21;
      v00 = nv00; v01 = nv01;
      v10 = nv10; v11 = nv11;
      v20 = nv20; v21 = nv21;
    } else if (pivot == 1) {
      // rotate (0,2)
      let new00 = c * c * m00 - 2.0 * s * c * m02 + s * s * m22;
      let new22 = s * s * m00 + 2.0 * s * c * m02 + c * c * m22;
      let new01 = c * m01 - s * m12;
      let new12 = s * m01 + c * m12;
      m00 = new00; m22 = new22; m02 = 0.0;
      m01 = new01; m12 = new12;
      let nv00 = c * v00 - s * v02; let nv02 = s * v00 + c * v02;
      let nv10 = c * v10 - s * v12; let nv12 = s * v10 + c * v12;
      let nv20 = c * v20 - s * v22; let nv22 = s * v20 + c * v22;
      v00 = nv00; v02 = nv02;
      v10 = nv10; v12 = nv12;
      v20 = nv20; v22 = nv22;
    } else {
      // rotate (1,2)
      let new11 = c * c * m11 - 2.0 * s * c * m12 + s * s * m22;
      let new22 = s * s * m11 + 2.0 * s * c * m12 + c * c * m22;
      let new01 = c * m01 - s * m02;
      let new02 = s * m01 + c * m02;
      m11 = new11; m22 = new22; m12 = 0.0;
      m01 = new01; m02 = new02;
      let nv01 = c * v01 - s * v02; let nv02 = s * v01 + c * v02;
      let nv11 = c * v11 - s * v12; let nv12 = s * v11 + c * v12;
      let nv21 = c * v21 - s * v22; let nv22 = s * v21 + c * v22;
      v01 = nv01; v02 = nv02;
      v11 = nv11; v12 = nv12;
      v21 = nv21; v22 = nv22;
    }
  }

  return EigResult(
    vec3(m00, m11, m22),
    vec3(v00, v10, v20),
    vec3(v01, v11, v21),
    vec3(v02, v12, v22),
  );
}

// Load pos.xyz from pass1_out[idx]. Returns zeros if idx < 0 (out-of-bounds).
fn pass1_pos(idx: i32) -> vec3<f32> {
  if (idx < 0) { return vec3(0.0, 0.0, 0.0); }
  let o = u32(idx) * 10u;
  return vec3(pass1_out[o], pass1_out[o + 1u], pass1_out[o + 2u]);
}

// Load cov6 from pass1_out[idx]. Returns zeros if idx < 0.
fn pass1_cov(idx: i32, dst00: ptr<function, f32>, dst01: ptr<function, f32>,
             dst02: ptr<function, f32>, dst11: ptr<function, f32>,
             dst12: ptr<function, f32>, dst22: ptr<function, f32>) {
  if (idx < 0) { return; }
  let o = u32(idx) * 10u + 3u;
  *dst00 = pass1_out[o + 0u];
  *dst01 = pass1_out[o + 1u];
  *dst02 = pass1_out[o + 2u];
  *dst11 = pass1_out[o + 3u];
  *dst12 = pass1_out[o + 4u];
  *dst22 = pass1_out[o + 5u];
}

fn pass1_op(idx: i32) -> f32 {
  if (idx < 0) { return 0.0; }
  return pass1_out[u32(idx) * 10u + 9u];
}

fn fetch_color(idx: i32) -> vec3<f32> {
  if (idx < 0) { return vec3(0.0, 0.0, 0.0); }
  let i = u32(idx);
  return vec3(
    color_uv[i],
    color_uv[dims.HW + i],
    color_uv[2u * dims.HW + i],
  );
}

// WGSL has no builtin isFinite. NaN is detectable via "NaN != NaN"; Inf via
// abs(x) above a finite threshold (fp32 max ~3.4e38; 1e30 is well past
// anything the lifter math could plausibly produce). Drops splats whose
// eigendecomp or position diverged.
fn is_finite(x: f32) -> bool {
  return x == x && abs(x) < 1e30;
}

// Bilinearly sample the opacity mask at normalized UV (u, v) ∈ [0,1]², clamping
// to the edge. Direct port of sampleMaskBilinear in ../types.ts so the CPU
// reference and the GPU lift cull identically.
fn sample_mask(u: f32, v: f32) -> f32 {
  let W = mask_params.width;
  let H = mask_params.height;
  if (W == 0u || H == 0u) { return 1.0; }
  let cu = clamp(u, 0.0, 1.0);
  let cv = clamp(v, 0.0, 1.0);
  let fx = cu * f32(W - 1u);
  let fy = cv * f32(H - 1u);
  let x0 = u32(floor(fx));
  let y0 = u32(floor(fy));
  let x1 = min(x0 + 1u, W - 1u);
  let y1 = min(y0 + 1u, H - 1u);
  let tx = fx - f32(x0);
  let ty = fy - f32(y0);
  let v00 = mask_data[y0 * W + x0];
  let v10 = mask_data[y0 * W + x1];
  let v01 = mask_data[y1 * W + x0];
  let v11 = mask_data[y1 * W + x1];
  let top = v00 + (v10 - v00) * tx;
  let bot = v01 + (v11 - v01) * tx;
  return top + (bot - top) * ty;
}

// Rotate a vector by the bundle's world_rotation quaternion (w, x, y, z).
fn world_rotate(v: vec3<f32>) -> vec3<f32> {
  let q = place.world_rot;
  let u = vec3<f32>(q.y, q.z, q.w);
  let c = 2.0 * cross(u, v);
  return v + q.x * c + cross(u, c);
}

// A culled or dropped texel: the slot stays allocated and becomes invisible.
// Writing zeroes to the covariance as well keeps the raycast + bounds passes off
// a stale ellipsoid at the old position.
fn write_empty(slot: u32) {
  center[slot] = vec4<f32>(0.0, 0.0, 0.0, 1.0);
  covariance_a[slot] = vec4<f32>(0.0);
  covariance_b[slot] = vec4<f32>(0.0);
  color[slot] = 0u;
}

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let s = gid.x;
  if (s >= dims.HW || s >= place.slot_count) { return; }
  let slot = place.slot_offset + s;

  // Sample-grid coords. align_corners=False: pixel_pos[i] = i / (N-1) * H - 0.5.
  let oy = s / dims.N;
  let ox = s % dims.N;
  let inv_nm1 = 1.0 / f32(dims.N - 1u);
  let py = f32(oy) * inv_nm1 * f32(dims.H) - 0.5;
  let px = f32(ox) * inv_nm1 * f32(dims.W) - 0.5;

  let y_lo = i32(floor(py));
  let y_hi = y_lo + 1;
  let fy = py - f32(y_lo);
  let x_lo = i32(floor(px));
  let x_hi = x_lo + 1;
  let fx = px - f32(x_lo);

  let H = i32(dims.H);
  let W = i32(dims.W);
  let y_lo_in = y_lo >= 0 && y_lo < H;
  let y_hi_in = y_hi >= 0 && y_hi < H;
  let x_lo_in = x_lo >= 0 && x_lo < W;
  let x_hi_in = x_hi >= 0 && x_hi < W;

  let i00 = select(-1, y_lo * W + x_lo, y_lo_in && x_lo_in);
  let i01 = select(-1, y_lo * W + x_hi, y_lo_in && x_hi_in);
  let i10 = select(-1, y_hi * W + x_lo, y_hi_in && x_lo_in);
  let i11 = select(-1, y_hi * W + x_hi, y_hi_in && x_hi_in);

  let w00 = (1.0 - fx) * (1.0 - fy);
  let w01 = fx * (1.0 - fy);
  let w10 = (1.0 - fx) * fy;
  let w11 = fx * fy;

  // Bilinear validity threshold (> 0.99).
  let v00 = select(0.0, f32(valid[u32(i00)]), i00 >= 0);
  let v01 = select(0.0, f32(valid[u32(i01)]), i01 >= 0);
  let v10 = select(0.0, f32(valid[u32(i10)]), i10 >= 0);
  let v11 = select(0.0, f32(valid[u32(i11)]), i11 >= 0);
  let v_sum = w00 * v00 + w01 * v01 + w10 * v10 + w11 * v11;
  if (v_sum < 0.99) { write_empty(slot); return; }

  // UV-space opacity-mask cull (occlusion map). The sample's UV is its grid
  // position normalized to [0,1]; drop the splat when the mask marks this region
  // hidden.
  if (mask_params.enabled != 0u) {
    if (sample_mask(f32(ox) * inv_nm1, f32(oy) * inv_nm1) < mask_params.threshold) {
      write_empty(slot);
      return;
    }
  }

  // Bilinear position
  let wp = w00 * pass1_pos(i00) + w01 * pass1_pos(i01)
         + w10 * pass1_pos(i10) + w11 * pass1_pos(i11);

  // Bilinear covariance
  var a00 = 0.0; var a01 = 0.0; var a02 = 0.0;
  var a11 = 0.0; var a12 = 0.0; var a22 = 0.0;
  var b00 = 0.0; var b01 = 0.0; var b02 = 0.0;
  var b11 = 0.0; var b12 = 0.0; var b22 = 0.0;
  pass1_cov(i00, &b00, &b01, &b02, &b11, &b12, &b22);
  a00 += w00 * b00; a01 += w00 * b01; a02 += w00 * b02;
  a11 += w00 * b11; a12 += w00 * b12; a22 += w00 * b22;
  b00 = 0.0; b01 = 0.0; b02 = 0.0; b11 = 0.0; b12 = 0.0; b22 = 0.0;
  pass1_cov(i01, &b00, &b01, &b02, &b11, &b12, &b22);
  a00 += w01 * b00; a01 += w01 * b01; a02 += w01 * b02;
  a11 += w01 * b11; a12 += w01 * b12; a22 += w01 * b22;
  b00 = 0.0; b01 = 0.0; b02 = 0.0; b11 = 0.0; b12 = 0.0; b22 = 0.0;
  pass1_cov(i10, &b00, &b01, &b02, &b11, &b12, &b22);
  a00 += w10 * b00; a01 += w10 * b01; a02 += w10 * b02;
  a11 += w10 * b11; a12 += w10 * b12; a22 += w10 * b22;
  b00 = 0.0; b01 = 0.0; b02 = 0.0; b11 = 0.0; b12 = 0.0; b22 = 0.0;
  pass1_cov(i11, &b00, &b01, &b02, &b11, &b12, &b22);
  a00 += w11 * b00; a01 += w11 * b01; a02 += w11 * b02;
  a11 += w11 * b11; a12 += w11 * b12; a22 += w11 * b22;

  // Bilinear colour
  let col = w00 * fetch_color(i00) + w01 * fetch_color(i01)
          + w10 * fetch_color(i10) + w11 * fetch_color(i11);

  // Bilinear opacity logit
  let op = w00 * pass1_op(i00) + w01 * pass1_op(i01)
         + w10 * pass1_op(i10) + w11 * pass1_op(i11);

  // Eigendecompose covariance → (scale via sqrt, rotation via det-flip).
  let ev = eig_decomp_3(a00, a01, a02, a11, a12, a22);

  // Drop splats whose eigendecomp or position is non-finite.
  if (!is_finite(ev.eigs.x) || !is_finite(ev.eigs.y) || !is_finite(ev.eigs.z) ||
      !is_finite(ev.v0.x) || !is_finite(ev.v0.y) || !is_finite(ev.v0.z) ||
      !is_finite(ev.v1.x) || !is_finite(ev.v1.y) || !is_finite(ev.v1.z) ||
      !is_finite(ev.v2.x) || !is_finite(ev.v2.y) || !is_finite(ev.v2.z) ||
      !is_finite(wp.x)    || !is_finite(wp.y)    || !is_finite(wp.z)) {
    write_empty(slot);
    return;
  }

  // THE SCALE CLAMP, unchanged: the trainer's own floor on a degenerate axis.
  // Pass 1 has already applied scaleLogBias / scaleLogMax / sigmaMax / triKappa /
  // sliver, so the eigenvalues arriving here are already the clamped covariance.
  let ws = vec3<f32>(
    sqrt(max(1e-12, ev.eigs.x)),
    sqrt(max(1e-12, ev.eigs.y)),
    sqrt(max(1e-12, ev.eigs.z)),
  ) * place.world_scale;

  // det([v0|v1|v2]); flip v0 sign when det < 0 so the basis is a proper rotation.
  let det = dot(ev.v0, cross(ev.v1, ev.v2));
  let sgn = select(-1.0, 1.0, det >= 0.0);

  // RECOMPOSE. M = R·diag(s) has the scaled eigenvectors as its COLUMNS, so
  // Σ = M·Mᵀ = Σ_k s_k² · (e_k ⊗ e_k). Rotating each eigenvector by the bundle's
  // world_rotation first is what puts Σ in scene space — the same rotation the
  // plücker camera travels the inverse of, so the decoders still see the trained
  // frame (../render/worldRotation.ts).
  //
  // This is `GaussianSplatUtils.writeCovariance` written as an outer-product sum
  // rather than a matrix product; `test/covariance.test.ts` pins the two together.
  let e0 = world_rotate(sgn * ev.v0) * ws.x;
  let e1 = world_rotate(ev.v1) * ws.y;
  let e2 = world_rotate(ev.v2) * ws.z;

  let c00 = e0.x * e0.x + e1.x * e1.x + e2.x * e2.x;
  let c01 = e0.x * e0.y + e1.x * e1.y + e2.x * e2.y;
  let c02 = e0.x * e0.z + e1.x * e1.z + e2.x * e2.z;
  let c11 = e0.y * e0.y + e1.y * e1.y + e2.y * e2.y;
  let c12 = e0.y * e0.z + e1.y * e1.z + e2.y * e2.z;
  let c22 = e0.z * e0.z + e1.z * e1.z + e2.z * e2.z;

  let scene = world_rotate(wp * place.world_scale) + place.world_offset.xyz;

  center[slot] = vec4<f32>(scene, 1.0);
  covariance_a[slot] = vec4<f32>(c00, c01, c02, c11);
  covariance_b[slot] = vec4<f32>(c12, c22, 0.0, 0.0);
  color[slot] = pack4x8unorm(vec4<f32>(
    clamp(col, vec3<f32>(0.0), vec3<f32>(1.0)),
    1.0 / (1.0 + exp(-op)),
  ));
}
