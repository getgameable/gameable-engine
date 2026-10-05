// What can be checked about a shader without a GPU.
//
// Node cannot compile WGSL, so nothing here proves a shader BUILDS. What it does prove
// is everything about the shipped STRING that a rewrite can get wrong and a reviewer
// cannot see: that the generator ran, that every shader kept its entry point, that the
// `#include` was resolved rather than left as a comment, that the covariance write
// order matches the CPU reference in `covariance.test.ts`, and that nothing survives
// from the renderer this port replaced.
//
// THE LAST ONE IS THE POINT. The POC packed spark's `ExtSplats` words and read them
// back to the CPU; a leftover `ExtSplats` binding or `packed` buffer here would mean a
// shader that still writes a format nothing reads — which compiles, runs, and renders
// nothing.

import { describe, expect, it } from 'vitest';

import * as shaders from './generated/index.js';

/** Every generated shader, by the name of its source file. */
const SOURCES: Record<string, string> = {
  'jacobian.wgsl': shaders.jacobianWgsl,
  'lift_pass1.wgsl': shaders.liftPass1Wgsl,
  'lift_pass2_cov.wgsl': shaders.liftPass2CovWgsl,
  'vert_transform.wgsl': shaders.vertTransformWgsl,
  'plucker.wgsl': shaders.pluckerWgsl,
  'lbs_common.wgsl': shaders.lbsCommonWgsl,
  'orl_deform.wgsl': shaders.orlDeformWgsl,
  'gnm_blend.wgsl': shaders.gnmBlendWgsl,
  'debug_vertex_lift.wgsl': shaders.debugVertexLiftWgsl,
};

/** The shaders that are dispatched directly; `lbs_common.wgsl` is included, not run. */
const ENTRY_POINTS = Object.keys(SOURCES).filter((name) => name !== 'lbs_common.wgsl');

describe('the generated shader modules', () => {
  it('exist for every shader in the tree', () => {
    // `scripts/wgsl-to-ts.mjs` runs in `pretest`; a missing module means it did not.
    for (const [name, source] of Object.entries(SOURCES)) {
      expect(source, name).toBeTypeOf('string');
      expect(source.length, name).toBeGreaterThan(200);
    }
  });

  it('declares a compute entry point in every dispatched shader', () => {
    for (const name of ENTRY_POINTS) {
      expect(SOURCES[name], name).toMatch(/@compute\s+@workgroup_size\(\d+\)\s*\r?\nfn main\(/);
    }
  });

  it('leaves no unresolved `#include` behind', () => {
    // The directive is resolved by string concatenation at generation time. One left
    // as a comment is a shader missing its LBS routine, which fails to build with a
    // message naming an undefined function rather than a missing file.
    for (const [name, source] of Object.entries(SOURCES)) {
      expect(source, name).not.toMatch(/^\s*\/\/\s*#include/m);
    }
  });

  it('shares ONE LBS routine between the two rig backends', () => {
    // Two copies would drift, and a drift in LBS is a face subtly in the wrong place
    // with no error anywhere. The marker the generator writes is what proves the shared
    // file was inlined rather than a second copy being pasted in.
    for (const name of ['orl_deform.wgsl', 'gnm_blend.wgsl']) {
      expect(SOURCES[name], name).toContain('begin #include "lbs_common.wgsl"');
      expect(SOURCES[name], name).toContain('fn lbs_apply(');
      expect(SOURCES[name], name).toContain('lbs_apply(p, v, params.maxInf)');
    }
    // And exactly once each: a double inline would redefine the function.
    for (const name of ['orl_deform.wgsl', 'gnm_blend.wgsl']) {
      expect(SOURCES[name].split('fn lbs_apply(').length - 1, name).toBe(1);
    }
  });
});

describe('the splat-sink write', () => {
  const writers = ['lift_pass2_cov.wgsl', 'debug_vertex_lift.wgsl'];

  it('binds the four sink buffers in group 1, in the documented order', () => {
    for (const name of writers) {
      const source = SOURCES[name];
      expect(source, name).toMatch(
        /@group\(1\) @binding\(0\) var<storage, read_write> center:\s+array<vec4<f32>>/,
      );
      expect(source, name).toMatch(
        /@group\(1\) @binding\(1\) var<storage, read_write> covariance_a:\s+array<vec4<f32>>/,
      );
      expect(source, name).toMatch(
        /@group\(1\) @binding\(2\) var<storage, read_write> covariance_b:\s+array<vec4<f32>>/,
      );
      expect(source, name).toMatch(
        /@group\(1\) @binding\(3\) var<storage, read_write> color:\s+array<u32>/,
      );
    }
  });

  it('writes the covariance in writeCovariance order, split across two vec4', () => {
    // A = (c00, c01, c02, c11); B = (c12, c22, 0, 0). Any other order renders a
    // plausible but wrong ellipsoid — see covariance.test.ts for the CPU reference.
    for (const name of writers) {
      expect(SOURCES[name], name).toContain('vec4<f32>(c00, c01, c02, c11)');
      expect(SOURCES[name], name).toContain('vec4<f32>(c12, c22, 0.0, 0.0)');
    }
  });

  it('packs the colour with pack4x8unorm and a sigmoid on the opacity logit', () => {
    // The decoder emits a LOGIT. Writing it straight clamps every splat to fully opaque
    // or fully transparent.
    expect(SOURCES['lift_pass2_cov.wgsl']).toContain('pack4x8unorm');
    expect(SOURCES['lift_pass2_cov.wgsl']).toMatch(/1\.0 \/ \(1\.0 \+ exp\(-op\)\)/);
    expect(SOURCES['debug_vertex_lift.wgsl']).toContain('pack4x8unorm');
  });

  it('addresses a slot as `slot_offset + texel`, with a constant per-branch count', () => {
    // Each texel owns a FIXED slot so index -> splat never changes across frames and the
    // sort's map stays valid. An atomic-compacted order reshuffles every lift and tears
    // the sort during camera motion.
    expect(SOURCES['lift_pass2_cov.wgsl']).toContain('place.slot_offset + s');
    expect(SOURCES['debug_vertex_lift.wgsl']).toContain('params.slot_offset + s');
  });

  it('keeps every clamp the trained model depends on', () => {
    // These are applied by the trainer AFTER the decoder, so they are not in the ONNX
    // and a lift that drops one renders a different model with nothing to see.
    const pass1 = SOURCES['lift_pass1.wgsl'];
    expect(pass1).toContain('scale_log_max');
    expect(pass1).toContain('tri_kappa');
    expect(pass1).toContain('sliver_q_min');
    expect(pass1).toContain('log_sigma_max');
    expect(pass1).toContain('scale_offset');
    // The eigenvalue floor, and the non-finite drop.
    expect(SOURCES['lift_pass2_cov.wgsl']).toContain('sqrt(max(1e-12, ev.eigs.x))');
    expect(SOURCES['lift_pass2_cov.wgsl']).toContain('fn is_finite(');
    expect(SOURCES['lift_pass2_cov.wgsl']).toContain('v_sum < 0.99');
  });
});

describe('nothing survives from the renderer this port replaced', () => {
  const FORBIDDEN = [
    // spark's packed-splat format and its bindings.
    'ExtSplats',
    'out_ext',
    'write_ext_splat',
    'PackedSplats',
    'setPackedSplat',
    'encode_quat_oct',
    'quant_scale',
    'LN_SCALE_MIN',
    // The atomic compaction the fixed-slot write replaces.
    'atomicAdd',
    'splat_to_texel',
  ];

  it('mentions no spark token in any shader', () => {
    for (const [name, source] of Object.entries(SOURCES)) {
      for (const token of FORBIDDEN) {
        expect(source.includes(token), `${name} still mentions \`${token}\``).toBe(false);
      }
    }
  });

  it('says `spark` nowhere, in any spelling', () => {
    for (const [name, source] of Object.entries(SOURCES)) {
      expect(/\bspark\b/i.test(source), `${name} still mentions spark`).toBe(false);
    }
  });
});

describe('the templated shaders', () => {
  it('leave their placeholders for the pipeline build to fill', () => {
    // WGSL uniform and workgroup arrays need compile-time sizes, so the joint count and
    // the coefficient count are substituted when the pipeline is built — which means the
    // SHIPPED string must still carry the placeholders.
    expect(SOURCES['orl_deform.wgsl']).toContain('array<vec4<f32>, SKIN_ROWS>');
    expect(SOURCES['orl_deform.wgsl']).toContain('array<vec4<f32>, BS_VEC4>');
    expect(SOURCES['gnm_blend.wgsl']).toContain('array<vec4<f32>, SKIN_ROWS>');
    expect(SOURCES['gnm_blend.wgsl']).toContain('array<vec4<f32>, EXPR_VEC4>');
    expect(SOURCES['gnm_blend.wgsl']).toContain('array<f32, MAX_COEFF>');
  });

  it('stages the GNM coefficients in workgroup memory behind a barrier', () => {
    // All 64 threads read the same 383 coefficients; staging turns 64 uniform loads per
    // coefficient into one, and the barrier is what makes the staged copy safe to read.
    expect(SOURCES['gnm_blend.wgsl']).toContain('var<workgroup> coeff');
    expect(SOURCES['gnm_blend.wgsl']).toContain('workgroupBarrier()');
  });

  it('unpacks the fp16 basis with core WGSL, needing no adapter feature', () => {
    // `f16` as a storage type needs `shader-f16`; `unpack2x16float` does not.
    expect(SOURCES['gnm_blend.wgsl']).toContain('unpack2x16float');
    expect(SOURCES['gnm_blend.wgsl']).not.toContain('enable f16');
  });
});

describe('pass 1 stays inside the default storage-buffer limit', () => {
  it('binds exactly 8 storage buffers', () => {
    // 8 is WebGPU's DEFAULT `maxStorageBuffersPerShaderStage`, so no adapter is refused
    // the lift over a limit. It bound 9 until `valid` was folded into `triim`, and the
    // integrated GPUs reporting exactly 8 were silently landing on a seconds-per-frame
    // CPU path.
    const storage = SOURCES['lift_pass1.wgsl'].match(/var<storage[^>]*>/g) ?? [];
    expect(storage.length).toBe(8);
  });
});
