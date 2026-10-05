// ORL deform: blendshapes + linear-blend skinning, one thread per vertex.
//
// Replaces the JS deform loop so the posed vertices are BORN on the GPU and go
// straight into GpuLifter.setPoseGpu — no per-frame vertex upload, no readback.
// The only per-frame CPU->GPU traffic is the two small uniforms below.
//
// Must stay numerically identical to ../deform.ts: calibration derives its
// per-vertex `corr` from the CPU deform, so any divergence here becomes a constant
// error in every pose.
//
// SKIN_ROWS / BS_VEC4 are templated at pipeline-build time (WGSL uniform arrays
// need compile-time sizes).
//
// The LBS half is INCLUDED, not copied: ../../../wgsl/lbs_common.wgsl is the one
// definition and gnm_blend.wgsl includes the same file. See that header for the
// binding contract the include requires.
//
// Ported from aos-threejs-poc/src/lib/orl/wgsl/orl_deform.wgsl @ cdd63b10

struct Params {
  numVerts: u32,
  maxInf: u32,
  _pad0: u32,
  _pad1: u32,
};

@group(0) @binding(0) var<storage, read> neutral: array<f32>;      // [V*3] cm
@group(0) @binding(1) var<storage, read> csrOffset: array<u32>;    // [V+1]
@group(0) @binding(2) var<storage, read> csrChannel: array<u32>;   // [N]
@group(0) @binding(3) var<storage, read> csrDelta: array<f32>;     // [N*3] cm, scale pre-multiplied
@group(0) @binding(4) var<storage, read> skinIdx: array<u32>;      // [V*maxInf]
@group(0) @binding(5) var<storage, read> skinW: array<f32>;        // [V*maxInf]
@group(0) @binding(6) var<storage, read_write> outVerts: array<f32>; // [V*3] cm

// Rows 0..2 of each joint's row-major skin matrix (world @ inverseBind), 3 per
// joint. Uniform, not storage: see lbs_common.wgsl.
@group(0) @binding(7) var<uniform> skinRows: array<vec4<f32>, SKIN_ROWS>;
// Blendshape channel weights, packed 4-per-vec4 (a uniform array<f32> would pad
// every element to 16 bytes).
@group(0) @binding(8) var<uniform> bsWeights: array<vec4<f32>, BS_VEC4>;
@group(0) @binding(9) var<uniform> params: Params;

// #include "lbs_common.wgsl"

fn channelWeight(c: u32) -> f32 {
  let v = bsWeights[c >> 2u];
  switch (c & 3u) {
    case 0u: { return v.x; }
    case 1u: { return v.y; }
    case 2u: { return v.z; }
    default: { return v.w; }
  }
}

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let v = gid.x;
  if (v >= params.numVerts) { return; }

  // 1) neutral + sum(weight * delta) over every target touching this vertex.
  let base = v * 3u;
  var p = vec3<f32>(neutral[base], neutral[base + 1u], neutral[base + 2u]);
  let lo = csrOffset[v];
  let hi = csrOffset[v + 1u];
  for (var e = lo; e < hi; e = e + 1u) {
    let w = channelWeight(csrChannel[e]);
    if (w != 0.0) {
      let d = e * 3u;
      p = p + w * vec3<f32>(csrDelta[d], csrDelta[d + 1u], csrDelta[d + 2u]);
    }
  }

  // 2) LBS — the shared routine.
  let acc = lbs_apply(p, v, params.maxInf);

  outVerts[base] = acc.x;
  outVerts[base + 1u] = acc.y;
  outVerts[base + 2u] = acc.z;
}
