// Per-face Jacobian columns + face validity.
// Mirrors the trainer's compute_face_Jacobian.
//
// Storage layout matches the JS exactly so pass 1 can read it the same way:
//   jacobians[f*9 + 0..3] = r0 (=v1-v0)
//   jacobians[f*9 + 3..6] = r1 (=v2-v0)
//   jacobians[f*9 + 6..9] = r2 (=n / sqrt(|n|))  — NOT a unit vector; matches
//                           utils/graphics_utils.py:safe_sqrt_normalize, which
//                           is what the splat decoder was trained against.
//
// face_valid[f] = 1 iff |cross(r0, r1)| > 0 (i.e. false only for NaN), else 0.
// Identity-Jacobian substitution for invalid texels happens in pass1.

struct Dims {
  num_faces: u32,
}

@group(0) @binding(0) var<storage, read>       verts:       array<f32>;
@group(0) @binding(1) var<storage, read>       faces:       array<u32>;
@group(0) @binding(2) var<storage, read_write> jacobians:   array<f32>;
@group(0) @binding(3) var<storage, read_write> face_valid:  array<u32>;
@group(0) @binding(4) var<uniform>             dims:        Dims;

fn fetch_vert(idx: u32) -> vec3<f32> {
  let o = idx * 3u;
  return vec3(verts[o], verts[o + 1u], verts[o + 2u]);
}

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let f = gid.x;
  if (f >= dims.num_faces) { return; }

  let i0 = faces[f * 3u + 0u];
  let i1 = faces[f * 3u + 1u];
  let i2 = faces[f * 3u + 2u];

  let v0 = fetch_vert(i0);
  let v1 = fetch_vert(i1);
  let v2 = fetch_vert(i2);

  let r0 = v1 - v0;
  let r1 = v2 - v0;
  let n = cross(r0, r1);
  let len = length(n);
  // Validity mirrors training, which has NO area threshold: safe_sqrt_normalize
  // clamps |n|^2 to 1e-20 (=> |n| >= 1e-10) and always keeps the real edge
  // basis. `len > 0.0` is false for NaN, preserving the NaN guard that the
  // identity-Jacobian branch in pass 1 exists for.
  //
  // An area threshold here is NOT a harmless guard: a sliver triangle whose
  // edges are ~0.1mm gets an IDENTITY Jacobian, so the decoder's UV-space
  // offsets/scales are applied in raw world units instead of being contracted
  // by the tiny edge basis — one texel becomes a ~0.4 world-unit, opacity-0.97
  // splat behind the head (the "halo"). Measured on eyeline V9b: face 6463 fell
  // to |n| = 3.6e-10, just under the old 1e-9 gate, and ~50 more faces sit
  // within one decade of it in ordinary poses.
  let valid = len > 0.0;
  face_valid[f] = select(0u, 1u, valid);

  // r2 = n / sqrt(|n|) — NOT a unit vector; matches safe_sqrt_normalize.
  let inv = select(0.0, 1.0 / sqrt(max(len, 1e-10)), valid);
  let r2 = n * inv;

  let o = f * 9u;
  jacobians[o + 0u] = r0.x; jacobians[o + 1u] = r0.y; jacobians[o + 2u] = r0.z;
  jacobians[o + 3u] = r1.x; jacobians[o + 4u] = r1.y; jacobians[o + 5u] = r1.z;
  jacobians[o + 6u] = r2.x; jacobians[o + 7u] = r2.y; jacobians[o + 8u] = r2.z;
}

// Ported from aos-threejs-poc/src/ogs/inference/wgsl/jacobian.wgsl @ cdd63b10
