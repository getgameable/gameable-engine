// Pass 1: per-texel covariance + position + opacity logit in UV space.
// The reference for the constants and the clamp is ../inference/triBound.ts +
// ../inference/splatScale.ts; this shader hand-inlines both.
//
// Output layout: pass1_out is HW slots of 10 f32 each:
//   [pos.xyz, cov6 (c00 c01 c02 c11 c12 c22), opacity_logit].
// Pass 2 bilinear-samples this layout.

struct Dims {
  H:  u32,
  W:  u32,
  HW: u32,
  N:  u32,  // unused here; pass2 reads it
  // Resolved on the CPU so this and the CPU lifter cannot disagree. Pass 2 declares
  // the first four fields only and reads the same buffer, which is legal because a
  // uniform binding may be larger than the struct that reads it.
  scale_log_bias: f32,
  scale_log_max:  f32,
  // Triangle-bounded clamp. Both 0 = OFF and pass 1 is bit-identical to before.
  // MUST mirror scene/multi_part_gaussian_model.py's lift-time projection and
  // utils/geom_reg.py -- the clamp runs AFTER the decoder, so the ONNX graph
  // cannot carry it and a browser lifting without it paints splats the trained
  // model never had. Reference implementation: src/ogs/inference/triBound.ts.
  // Order matters: GpuLifter writes all seven tail f32 in this order from offset 16.
  tri_kappa:      f32,
  sliver_q_min:   f32,
  // The trainer's scale map (../inference/splatScale.ts). bounded = 1 selects
  // log(sigma_max) + logsigmoid(raw + scale_offset) and scale_log_bias is NOT
  // added -- it is folded into the offset, and adding both applies it twice.
  // bounded = 0 keeps the additive map, where scale_offset IS scale_log_bias.
  bounded:        f32,
  log_sigma_max:  f32,
  scale_offset:   f32,
}

fn log_sigmoid(x: f32) -> f32 {
  // exp on its non-overflowing side in each branch, as torch's F.logsigmoid does.
  if (x >= 0.0) { return -log(1.0 + exp(-x)); }
  return x - log(1.0 + exp(x));
}

fn splat_scale(raw: f32, dims_bounded: f32, dims_log_sigma_max: f32,
               dims_offset: f32, dims_log_max: f32) -> f32 {
  let t = raw + dims_offset;
  var ls = t;
  if (dims_bounded != 0.0) { ls = dims_log_sigma_max + log_sigmoid(t); }
  return exp(min(ls, dims_log_max));
}

// 8 storage buffers, never 9: 8 is WebGPU's DEFAULT limit, so a ninth refuses a stock adapter
// the GPU lift entirely. The mesh's `valid` is what got folded away — GpuLifter masks it into
// triim at upload, so an invalid texel arrives as fid < 0 and pass 2 still binds it in full.
@group(0) @binding(0) var<storage, read>       jacobians:  array<f32>;   // F * 9
@group(0) @binding(1) var<storage, read>       face_valid: array<u32>;   // F
@group(0) @binding(2) var<storage, read>       idxim:      array<i32>;   // HW * 3
@group(0) @binding(3) var<storage, read>       barim:      array<f32>;   // HW * 3
@group(0) @binding(4) var<storage, read>       triim:      array<i32>;   // HW; fid < 0 = invalid texel
@group(0) @binding(5) var<storage, read>       verts:      array<f32>;   // V * 3
@group(0) @binding(6) var<storage, read>       geom_uv:    array<f32>;   // 11 * HW
@group(0) @binding(7) var<storage, read_write> pass1_out:  array<f32>;   // HW * 10
@group(0) @binding(8) var<uniform>             dims:       Dims;

// -1 IS A REAL INDEX IN TORCH, AND OUT OF BOUNDS HERE.
// `idxim` holds -1 at every texel outside a UV chart. The trainer indexes with
// `verts2[idxim]`, and torch (like numpy) WRAPS: -1 is the last vertex. This
// took `u32(-1)` = 4294967295 and read past the end of the buffer, which WGSL
// resolves to zero rather than to that vertex -- a silently different base
// position on every chart-edge texel, feeding the bilinear footprint of the
// samples next to it. Measured cost when it was wrong: 6 head splats and 96 body
// splats, each on a chart edge.
//
// arrayLength avoids a tenth binding -- 8 storage buffers is WebGPU's default
// limit and this shader is already at it (see the binding block above).
fn fetch_vert(idx: i32) -> vec3<f32> {
  let nv = i32(arrayLength(&verts) / 3u);
  let k = select(idx, idx + nv, idx < 0);
  let o = u32(k) * 3u;
  return vec3(verts[o], verts[o + 1u], verts[o + 2u]);
}

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let p = gid.x;
  if (p >= dims.HW) { return; }

  let fid = triim[p];
  let is_valid = (fid >= 0) && (face_valid[u32(fid)] != 0u);

  // jXY = J[row X][col Y]. The JS stores columns r0,r1,r2 contiguously, so
  // row X = (r0[X], r1[X], r2[X]). Identity Jacobian on invalid texels
  // (avoids NaN contamination in pass 2's bilinear sample near boundaries).
  var j00 = 1.0; var j01 = 0.0; var j02 = 0.0;
  var j10 = 0.0; var j11 = 1.0; var j12 = 0.0;
  var j20 = 0.0; var j21 = 0.0; var j22 = 1.0;
  if (is_valid) {
    let jo = u32(fid) * 9u;
    j00 = jacobians[jo + 0u]; j01 = jacobians[jo + 3u]; j02 = jacobians[jo + 6u];
    j10 = jacobians[jo + 1u]; j11 = jacobians[jo + 4u]; j12 = jacobians[jo + 7u];
    j20 = jacobians[jo + 2u]; j21 = jacobians[jo + 5u]; j22 = jacobians[jo + 8u];
  }

  // Base position via barycentric interpolation. JS uses idxim/barim
  // unconditionally even for invalid texels — invalid base positions are
  // filtered later by the bilinear-validity test in pass 2.
  let bx = barim[p * 3u + 0u];
  let by = barim[p * 3u + 1u];
  let bz = barim[p * 3u + 2u];
  let v_i0 = fetch_vert(idxim[p * 3u + 0u]);
  let v_i1 = fetch_vert(idxim[p * 3u + 1u]);
  let v_i2 = fetch_vert(idxim[p * 3u + 2u]);
  let base = bx * v_i0 + by * v_i1 + bz * v_i2;

  // CNN outputs at this texel
  let HW = dims.HW;
  let ox = geom_uv[0u * HW + p];
  let oy = geom_uv[1u * HW + p];
  let oz = geom_uv[2u * HW + p];
  let qw = geom_uv[3u * HW + p];
  let qx = geom_uv[4u * HW + p];
  let qy = geom_uv[5u * HW + p];
  let qz = geom_uv[6u * HW + p];
  // Bias THEN clamp, matching the trainer: clamping first would cap a different
  // quantity and let e^bias through on top of the ceiling.
  let sx = splat_scale(geom_uv[7u * HW + p], dims.bounded, dims.log_sigma_max,
                       dims.scale_offset, dims.scale_log_max);
  let sy = splat_scale(geom_uv[8u * HW + p], dims.bounded, dims.log_sigma_max,
                       dims.scale_offset, dims.scale_log_max);
  let sz = splat_scale(geom_uv[9u * HW + p], dims.bounded, dims.log_sigma_max,
                       dims.scale_offset, dims.scale_log_max);
  let op = geom_uv[10u * HW + p];

  // Position = J · offset + base
  let pos_x = j00 * ox + j01 * oy + j02 * oz + base.x;
  let pos_y = j10 * ox + j11 * oy + j12 * oz + base.y;
  let pos_z = j20 * ox + j21 * oy + j22 * oz + base.z;

  // Rotation matrix from normalized quaternion
  let qlen = sqrt(qw * qw + qx * qx + qy * qy + qz * qz);
  let ql = select(1.0, qlen, qlen > 0.0);
  let nqw = qw / ql; let nqx = qx / ql; let nqy = qy / ql; let nqz = qz / ql;
  let r00 = 1.0 - 2.0 * (nqy * nqy + nqz * nqz);
  let r01 = 2.0 * (nqx * nqy - nqz * nqw);
  let r02 = 2.0 * (nqx * nqz + nqy * nqw);
  let r10 = 2.0 * (nqx * nqy + nqz * nqw);
  let r11 = 1.0 - 2.0 * (nqx * nqx + nqz * nqz);
  let r12 = 2.0 * (nqy * nqz - nqx * nqw);
  let r20 = 2.0 * (nqx * nqz - nqy * nqw);
  let r21 = 2.0 * (nqy * nqz + nqx * nqw);
  let r22 = 1.0 - 2.0 * (nqx * nqx + nqy * nqy);

  // L = R · diag(s),  M = J · L,  Cov = M · Mᵀ (upper triangle only).
  let l00 = r00 * sx; let l01 = r01 * sy; let l02 = r02 * sz;
  let l10 = r10 * sx; let l11 = r11 * sy; let l12 = r12 * sz;
  let l20 = r20 * sx; let l21 = r21 * sy; let l22 = r22 * sz;
  let m00 = j00 * l00 + j01 * l10 + j02 * l20;
  let m01 = j00 * l01 + j01 * l11 + j02 * l21;
  let m02 = j00 * l02 + j01 * l12 + j02 * l22;
  let m10 = j10 * l00 + j11 * l10 + j12 * l20;
  let m11 = j10 * l01 + j11 * l11 + j12 * l21;
  let m12 = j10 * l02 + j11 * l12 + j12 * l22;
  let m20 = j20 * l00 + j21 * l10 + j22 * l20;
  let m21 = j20 * l01 + j21 * l11 + j22 * l21;
  let m22 = j20 * l02 + j21 * l12 + j22 * l22;
  // ── Triangle-bounded clamp ────────────────────────────────────────────────
  // The columns of M are exactly world_axis_extents(): M = J.R.diag(exp(s)),
  // and that returns the column norms of J.R times exp(s). The host triangle
  // comes from Jacobian columns 0 and 1, which ARE its two edge vectors
  // (compute_face_Jacobian builds it that way) -- so neither needs new data.
  // Column 2 is the normal and is NOT unit length (it is n/sqrt(|n|)), which is
  // why the area is taken from cross(e0, e1) and not from that column.
  var g2 = 1.0;
  var sliver_killed = false;
  if (dims.tri_kappa > 0.0 && is_valid) {
    let e0 = vec3<f32>(j00, j10, j20);
    let e1 = vec3<f32>(j01, j11, j21);
    let tri_edge = max(max(length(e0), length(e1)), length(e1 - e0));
    let tri_area = 0.5 * length(cross(e0, e1));
    let EQ = 0.6580370064762462;   // sqrt(area)/edge for an equilateral face
    let DERATE_RATIO = 5.0;        // utils.geom_reg._SLIVER_DERATE_RATIO
    let q = clamp(sqrt(max(tri_area, 0.0)) / max(EQ * tri_edge, 1e-12), 0.0, 1.0);
    var bound = tri_edge;
    if (dims.sliver_q_min > 0.0) {
      bound = bound * min(1.0, q / (DERATE_RATIO * dims.sliver_q_min));
      sliver_killed = q < dims.sliver_q_min;
    }
    let reach = max(max(length(vec3<f32>(m00, m10, m20)),
                        length(vec3<f32>(m01, m11, m21))),
                    length(vec3<f32>(m02, m12, m22)));
    let g = min(1.0, (dims.tri_kappa * bound) / max(reach, 1e-12));
    g2 = g * g;   // covariance is M.M^T, so scaling M by g scales it by g^2
  }
  let c00 = (m00 * m00 + m01 * m01 + m02 * m02) * g2;
  let c01 = (m00 * m10 + m01 * m11 + m02 * m12) * g2;
  let c02 = (m00 * m20 + m01 * m21 + m02 * m22) * g2;
  let c11 = (m10 * m10 + m11 * m11 + m12 * m12) * g2;
  let c12 = (m10 * m20 + m11 * m21 + m12 * m22) * g2;
  let c22 = (m20 * m20 + m21 * m21 + m22 * m22) * g2;

  let o = p * 10u;
  pass1_out[o + 0u] = pos_x;
  pass1_out[o + 1u] = pos_y;
  pass1_out[o + 2u] = pos_z;
  pass1_out[o + 3u] = c00;
  pass1_out[o + 4u] = c01;
  pass1_out[o + 5u] = c02;
  pass1_out[o + 6u] = c11;
  pass1_out[o + 7u] = c12;
  pass1_out[o + 8u] = c22;
  pass1_out[o + 9u] = op;
}

// Ported from aos-threejs-poc/src/ogs/inference/wgsl/lift_pass1.wgsl @ cdd63b10
