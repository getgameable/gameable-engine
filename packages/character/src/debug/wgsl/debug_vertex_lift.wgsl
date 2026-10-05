// One isotropic gaussian per RIG VERTEX, straight into a splat sink's slot range.
//
// WHAT THIS IS FOR. The real lift needs a bundle's geometry and appearance decoders
// (`lift_pass1.wgsl` + `lift_pass2_cov.wgsl`), and those are trained per character and
// per topology. A rig backend that has just been ported — a new `.aosrig` pack, a
// re-baked head, an ORL DNA nobody has decoders for yet — cannot be looked at at all
// until they exist, so a rig bug is invisible until two teams have shipped. This pass
// closes that gap: it reads the SAME `vertsBuffer` the lift reads and writes the SAME
// four sink buffers the lift writes, so what you see is the rig stage and nothing else.
//
// IT IS NOT A RENDERER. Every gaussian is a sphere of fixed radius with a flat colour;
// there is no view dependence, no opacity model and no covariance from the model. A
// head drawn this way looks like a point cloud, which is the point — anything that
// looks like a face would hide the thing being debugged.
//
// THE SINK CONTRACT is three r186's `createStorageBuffers` layout, identical to
// `lift_pass2_cov.wgsl` down to the binding order and the covariance split, because a
// debug path that wrote a different format would prove nothing about the real one:
//
//   center[i]       vec4<f32>  xyz = centre (object space), w = 1
//   covariance_a[i] vec4<f32>  (c00, c01, c02, c11)
//   covariance_b[i] vec4<f32>  (c12, c22, 0, 0)
//   color[i]        u32        pack4x8unorm(r, g, b, opacity)
//
// SLOTS ARE FIXED, exactly as in the real lift: vertex `v` owns slot
// `params.slot_offset + v` for the life of the preview, so three's `CountingSort` index
// -> splat map survives the next frame. A slot past the vertex count is not skipped, it
// is CLEARED — an allocated-but-unwritten slot otherwise renders whatever the buffer
// happened to contain.
//
// THE TRANSFORM IS A 3x4 ROW-MAJOR AFFINE, rig frame -> the sink object's local space.
// It carries the rig's unit scale (GNM is metres, ORL centimetres), the yaw that faces
// a head at the camera, and the offset that puts it at the origin — one matrix, applied
// once, so no stage downstream has to know which rig produced the vertices.

struct Params {
  // Vertices in `verts`. Slots past this are cleared.
  vertex_count: u32,
  // First slot of this preview's range.
  slot_offset:  u32,
  // Slots the range owns. The dispatch is sized from this.
  slot_count:   u32,
  // 0 = per-vertex tint, 1 = radial pseudo-normal, 2 = flat.
  shading:      u32,
  // Rig -> object, row-major 3x4.
  row0:         vec4<f32>,
  row1:         vec4<f32>,
  row2:         vec4<f32>,
  // Gaussian radius in OBJECT space (metres), the same units as `row*` produces.
  sigma:        f32,
  opacity:      f32,
  pad0:         f32,
  pad1:         f32,
  // Object-space centre the radial pseudo-normal points away from. w unused.
  centroid:     vec4<f32>,
}

@group(0) @binding(0) var<storage, read>       verts:        array<f32>;  // V * 3, rig units
@group(0) @binding(1) var<storage, read>       tint:         array<u32>;  // V, pack4x8unorm
@group(0) @binding(2) var<uniform>             params:       Params;

@group(1) @binding(0) var<storage, read_write> center:       array<vec4<f32>>;
@group(1) @binding(1) var<storage, read_write> covariance_a: array<vec4<f32>>;
@group(1) @binding(2) var<storage, read_write> covariance_b: array<vec4<f32>>;
@group(1) @binding(3) var<storage, read_write> color:        array<u32>;

fn is_finite(x: f32) -> bool {
  // Same test the real lift uses: NaN fails `x == x`, and an infinity survives it.
  return x == x && abs(x) < 3.4e38;
}

// An unused or non-finite slot: allocated, addressable, invisible.
fn write_empty(slot: u32) {
  center[slot] = vec4<f32>(0.0, 0.0, 0.0, 1.0);
  covariance_a[slot] = vec4<f32>(0.0);
  covariance_b[slot] = vec4<f32>(0.0);
  color[slot] = 0u;
}

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let s = gid.x;
  if (s >= params.slot_count) { return; }
  let slot = params.slot_offset + s;
  if (s >= params.vertex_count) { write_empty(slot); return; }

  let b = s * 3u;
  let p4 = vec4<f32>(verts[b], verts[b + 1u], verts[b + 2u], 1.0);
  let p = vec3<f32>(dot(params.row0, p4), dot(params.row1, p4), dot(params.row2, p4));
  if (!is_finite(p.x) || !is_finite(p.y) || !is_finite(p.z)) { write_empty(slot); return; }

  // An isotropic gaussian: Σ = σ²·I. Written through the same six named terms the real
  // lift writes, in `GaussianSplatUtils.writeCovariance` order.
  let s2 = params.sigma * params.sigma;
  let c00 = s2;
  let c01 = 0.0;
  let c02 = 0.0;
  let c11 = s2;
  let c12 = 0.0;
  let c22 = s2;

  var rgb: vec3<f32>;
  if (params.shading == 0u) {
    rgb = unpack4x8unorm(tint[s]).rgb;
  } else if (params.shading == 1u) {
    // No normals exist on a rig buffer — a rig is vertices, and recomputing them would
    // need the topology and a second pass. The direction away from the head's centroid
    // is a good enough stand-in to read curvature by, and it costs nothing.
    let d = p - params.centroid.xyz;
    let n = select(vec3<f32>(0.0, 0.0, 1.0), normalize(d), length(d) > 1e-9);
    rgb = 0.5 + 0.5 * n;
  } else {
    rgb = vec3<f32>(0.85, 0.85, 0.9);
  }

  center[slot] = vec4<f32>(p, 1.0);
  covariance_a[slot] = vec4<f32>(c00, c01, c02, c11);
  covariance_b[slot] = vec4<f32>(c12, c22, 0.0, 0.0);
  color[slot] = pack4x8unorm(vec4<f32>(
    clamp(rgb, vec3<f32>(0.0), vec3<f32>(1.0)),
    clamp(params.opacity, 0.0, 1.0),
  ));
}
