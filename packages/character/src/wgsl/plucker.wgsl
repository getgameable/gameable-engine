// Plücker rays for a pinhole camera, computed on-GPU. Exact port of
// computePluckerRays in ../inference/plucker.ts — each texel gets (moment = origin × dir,
// dir). Output layout matches the CPU version: channel-major (6, H, W) flat,
//   out[c*stride + (y*W + x)],  c in 0..5  (moment.xyz then dir.xyz)
// which is the [1,6,1,H,W] tensor appr expects.
//
// Camera basis is precomputed on the CPU (a few three.js ops) and passed in the
// uniform; the per-texel loop (the expensive part) runs here.

struct Params {
  origin:  vec4<f32>,   // xyz used
  forward: vec4<f32>,   // xyz used
  right:   vec4<f32>,   // xyz used
  up:      vec4<f32>,   // xyz used
  tanFov:      f32,
  aspect:      f32,
  originScale: f32,     // 1/worldScale — camera origin into the splat-local (cm) frame
  momentScale: f32,     // scales the moment channels (1 = full plücker, 0 = direction-only)
  dims:        vec4<u32>,   // x=W, y=H, z=stride(=W*H)
}

@group(0) @binding(0) var<storage, read_write> out: array<f32>;
@group(0) @binding(1) var<uniform>             p:   Params;

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let idx = gid.x;
  let stride = p.dims.z;
  if (idx >= stride) { return; }

  let W = p.dims.x;
  let H = p.dims.y;
  let x = idx % W;
  let y = idx / W;

  // nx in [-1,1] across width, ny flipped so top = +1 (matches plucker.ts).
  let nx = (2.0 * (f32(x) + 0.5)) / f32(W) - 1.0;
  let ny = 1.0 - (2.0 * (f32(y) + 0.5)) / f32(H);

  let dir = normalize(
    p.forward.xyz
    + p.right.xyz * (nx * p.tanFov * p.aspect)
    + p.up.xyz    * (ny * p.tanFov)
  );
  let moment = cross(p.origin.xyz * p.originScale, dir) * p.momentScale;

  out[0u * stride + idx] = moment.x;
  out[1u * stride + idx] = moment.y;
  out[2u * stride + idx] = moment.z;
  out[3u * stride + idx] = dir.x;
  out[4u * stride + idx] = dir.y;
  out[5u * stride + idx] = dir.z;
}

// Ported from aos-threejs-poc/src/ogs/inference/wgsl/plucker.wgsl @ cdd63b10
