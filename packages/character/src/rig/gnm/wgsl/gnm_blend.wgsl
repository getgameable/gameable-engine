// GNM head: expression blend + gaze + linear-blend skinning, one thread per vertex.
//
// The whole rig->vertices stage for Google's parametric head, in one pass:
//
//   v = neutral[v] + Σ_c expr[c] · basis[c][v]      (383 coefficients, dense)
//   v = v + eyeWeight[e][v] · (R_e·(v - eyePos[e]) - (v - eyePos[e]))   (gaze)
//   v = v + stitch[v]                               (neck seam, baked)
//   v = LBS(v)                                      (head / neck / spine)
//
// COEFFICIENT-MAJOR BASES, and it is the layout that matters. The bake stores
// `basis` as `(E, V, 3)` — every vertex of coefficient 0, then every vertex of
// coefficient 1. A thread owning vertex `v` therefore strides by `V*3` between
// coefficients, which is the worst possible access pattern; transposing to
// vertex-major `(V, E, 3)` at pack time makes a thread's 383 reads contiguous. The
// pack writes vertex-major (`tools/gnm_pack.py`) and this shader reads it that way.
//
// WORKGROUP-SHARED COEFFICIENTS. All 64 threads in a workgroup read the SAME 383
// expression coefficients, once per coefficient each. Staging them into workgroup
// memory turns 64 uniform loads per coefficient into one, and the barrier costs a
// single synchronisation per dispatch.
//
// fp16 BASIS. The bake quantises `basis` to fp16 with a per-coefficient f32 scale,
// which is a ~2x size win on a 383 × 17,821 × 3 array (78 MB -> 39 MB) for a
// measured worst-case vertex error well inside the 1e-3 cm gate
// (`test/gnm.test.ts` pins both the quantisation error and the reference match).
// WGSL has no f16 storage type without the `shader-f16` feature, so the pack stores
// the halves as PAIRS PACKED IN u32 and this shader unpacks with `unpack2x16float`,
// which is core WGSL and needs no feature at all.
//
// MAX_COEFF is templated at pipeline-build time (workgroup arrays need a
// compile-time size).

struct Params {
  numVerts:   u32,
  numCoeff:   u32,
  maxInf:     u32,
  useStitch:  u32,
  // Eye joints, in ("left_eye", "right_eye") order. w unused.
  eyePos0:    vec4<f32>,
  eyePos1:    vec4<f32>,
  // Gaze as a rotation per eye, quaternion (w, x, y, z). Identity = look ahead.
  eyeRot0:    vec4<f32>,
  eyeRot1:    vec4<f32>,
}

@group(0) @binding(0) var<storage, read> neutral: array<f32>;        // [V*3] metres
// Vertex-major fp16 pairs: vertex v, coefficient c, component k is at
// ((v*numCoeff + c)*3 + k), one f16 per slot, two slots per u32 word.
@group(0) @binding(1) var<storage, read> basis: array<u32>;          // [ceil(V*E*3 / 2)]
@group(0) @binding(2) var<storage, read> basisScale: array<f32>;     // [E]
@group(0) @binding(3) var<storage, read> eyeWeight: array<f32>;      // [2*V]
@group(0) @binding(4) var<storage, read> stitch: array<f32>;         // [V*3] or a 3-float dummy
@group(0) @binding(5) var<storage, read> skinIdx: array<u32>;        // [V*maxInf]
@group(0) @binding(6) var<storage, read> skinW: array<f32>;          // [V*maxInf]
@group(0) @binding(7) var<storage, read_write> outVerts: array<f32>; // [V*3] metres

@group(0) @binding(8) var<uniform> skinRows: array<vec4<f32>, SKIN_ROWS>;
// The 383 expression coefficients, packed 4-per-vec4.
@group(0) @binding(9) var<uniform> expr: array<vec4<f32>, EXPR_VEC4>;
@group(0) @binding(10) var<uniform> params: Params;

// #include "lbs_common.wgsl"

// One workgroup's staged copy of the coefficient vector, scaled by its per-basis
// f32 scale so the inner loop does one multiply instead of two.
var<workgroup> coeff: array<f32, MAX_COEFF>;

fn exprAt(c: u32) -> f32 {
  let v = expr[c >> 2u];
  switch (c & 3u) {
    case 0u: { return v.x; }
    case 1u: { return v.y; }
    case 2u: { return v.z; }
    default: { return v.w; }
  }
}

// Read one fp16 lane out of the packed basis array.
fn basisAt(slot: u32) -> f32 {
  let pair = unpack2x16float(basis[slot >> 1u]);
  return select(pair.x, pair.y, (slot & 1u) == 1u);
}

// Rotate a vector by a quaternion (w, x, y, z).
fn quatRotate(q: vec4<f32>, v: vec3<f32>) -> vec3<f32> {
  let u = vec3<f32>(q.y, q.z, q.w);
  let c = 2.0 * cross(u, v);
  return v + q.x * c + cross(u, c);
}

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>,
        @builtin(local_invocation_index) lid: u32) {
  // Stage the coefficients. Every thread walks a stride-64 slice, so the 383
  // uniform reads are shared by the whole workgroup instead of repeated 64 times.
  for (var c = lid; c < params.numCoeff; c = c + 64u) {
    coeff[c] = exprAt(c) * basisScale[c];
  }
  workgroupBarrier();

  let v = gid.x;
  if (v >= params.numVerts) { return; }
  let base = v * 3u;

  // 1) neutral + Σ_c coeff[c] · basis[v][c]
  var p = vec3<f32>(neutral[base], neutral[base + 1u], neutral[base + 2u]);
  let row = v * params.numCoeff * 3u;
  for (var c = 0u; c < params.numCoeff; c = c + 1u) {
    let w = coeff[c];
    if (w == 0.0) { continue; }
    let o = row + c * 3u;
    p = p + w * vec3<f32>(basisAt(o), basisAt(o + 1u), basisAt(o + 2u));
  }

  // 2) Gaze. GNM rotates each eyeball about its own joint and blends by that
  //    joint's skinning weight, which is how the model itself poses gaze — there
  //    is no jaw or eye bone in the body rig to do it with.
  let wl = eyeWeight[v];
  if (wl != 0.0) {
    let rel = p - params.eyePos0.xyz;
    p = p + wl * (quatRotate(params.eyeRot0, rel) - rel);
  }
  let wr = eyeWeight[params.numVerts + v];
  if (wr != 0.0) {
    let rel = p - params.eyePos1.xyz;
    p = p + wr * (quatRotate(params.eyeRot1, rel) - rel);
  }

  // 3) The neck seam, baked offline: the head shell's lower boundary pulled onto
  //    the body's opening and faded out over a band of the neck. Head-local and
  //    pose-independent, so it is a constant add.
  if (params.useStitch != 0u) {
    p = p + vec3<f32>(stitch[base], stitch[base + 1u], stitch[base + 2u]);
  }

  // 4) LBS — the shared routine, identical to ORL's.
  let acc = lbs_apply(p, v, params.maxInf);

  outVerts[base] = acc.x;
  outVerts[base + 1u] = acc.y;
  outVerts[base + 2u] = acc.z;
}
