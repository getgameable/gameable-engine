// In-place per-vertex affine transform of bufVerts:
//   v' = v·M + offset + (useCorr ? corr[i] : 0)      (M = 3x3, row-vector product)
//
// A rig backend emits vertices in its own frame and units; the lifter (jacobians
// + pass1 base position) works in the bundle's trained space. GpuLifter.setPoseGpu
// folds the conversion into one compute pass so posed verts never leave the GPU.
//
// Two anchoring modes, ONE pass. The single-region bundle uses a scaled identity
// + a single learned MEAN offset. A multi-region branch fits a full similarity
// (scale + rotation + translation) against its baked neutral and anchors PER
// VERTEX on top (corr = baked neutral − M·rig(baseRig)); a mean offset there
// scatters splats. Both terms are needed and neither substitutes for the other:
// M puts DISPLACEMENTS in the checkpoint's frame, corr puts the NEUTRAL on the
// tracked surface the decoders were trained against. corr is uploaded once at
// calibration, so the per-frame cost is one extra buffer read.

struct Params {
  lin0:   vec4<f32>,   // xyz = ROW 0 of M
  lin1:   vec4<f32>,   // row 1
  lin2:   vec4<f32>,   // row 2
  offset: vec4<f32>,   // xyz used
  n:      vec4<u32>,   // x = numVerts, y = useCorr (0/1)
}

@group(0) @binding(0) var<storage, read_write> verts: array<f32>;
@group(0) @binding(1) var<uniform>             p:     Params;
// V*3 floats when installed; a 3-float dummy when unused (a bind group must
// still be complete). Read only when p.n.y != 0.
@group(0) @binding(2) var<storage, read>       corr:  array<f32>;

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = gid.x;
  if (i >= p.n.x) { return; }
  let o = i * 3u;
  var cx = 0.0;
  var cy = 0.0;
  var cz = 0.0;
  if (p.n.y != 0u) {
    cx = corr[o + 0u];
    cy = corr[o + 1u];
    cz = corr[o + 2u];
  }
  let v = vec3<f32>(verts[o + 0u], verts[o + 1u], verts[o + 2u]);
  // Row-vector product v·M: rows scaled by the matching component, matching the
  // server's `v @ lin` so the two paths cannot disagree on the convention.
  let m = v.x * p.lin0.xyz + v.y * p.lin1.xyz + v.z * p.lin2.xyz;
  verts[o + 0u] = m.x + p.offset.x + cx;
  verts[o + 1u] = m.y + p.offset.y + cy;
  verts[o + 2u] = m.z + p.offset.z + cz;
}

// Ported from aos-threejs-poc/src/ogs/inference/wgsl/vert_transform.wgsl @ cdd63b10
