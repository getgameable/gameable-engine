// Linear-blend skinning, shared by BOTH rig backends.
//
// ORL and GNM differ entirely in how a control vector becomes a blendshaped
// neutral — RigLogic's 870-joint solve plus ~2.4 M sparse int8 deltas, versus a
// 383-coefficient dense basis — and then do exactly the same thing to it. Two
// copies of this loop would drift, and a drift in LBS is a face that is subtly in
// the wrong place with nothing to see, so `scripts/wgsl-to-ts.mjs` resolves
// `// #include "lbs_common.wgsl"` by string concatenation and both shaders carry
// one definition.
//
// THE CONTRACT the including shader must satisfy:
//
//   var<storage, read> skinIdx : array<u32>;   // [V * maxInf]
//   var<storage, read> skinW   : array<f32>;   // [V * maxInf]
//   var<uniform>       skinRows: array<vec4<f32>, SKIN_ROWS>;  // 3 per joint
//
// `skinRows` is rows 0..2 of each joint's ROW-MAJOR `world · inverseBind`, three
// `vec4` per joint. Uniform, not storage: it is ~42 KB for a MetaHuman head, and
// keeping the storage-binding count low means neither pipeline depends on an
// adapter granting more than the WebGPU default (see ../rig/orl/gpuLimits.ts for
// the 64 KiB ceiling that buys).
//
// Zero-weight influences are SKIPPED, matching the CPU loop's `if (w === 0)
// continue` — the padding slots hold joint index 0, and summing them in would drag
// every vertex toward the root joint by the padding weight.

fn lbs_apply(p: vec3<f32>, vertex: u32, max_inf: u32) -> vec3<f32> {
  let p4 = vec4<f32>(p, 1.0);
  var acc = vec3<f32>(0.0, 0.0, 0.0);
  let si = vertex * max_inf;
  for (var k = 0u; k < max_inf; k = k + 1u) {
    let w = skinW[si + k];
    if (w == 0.0) { continue; }
    let r = skinIdx[si + k] * 3u;
    acc = acc + w * vec3<f32>(
      dot(skinRows[r], p4),
      dot(skinRows[r + 1u], p4),
      dot(skinRows[r + 2u], p4),
    );
  }
  return acc;
}
