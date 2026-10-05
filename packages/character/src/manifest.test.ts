// The bundle manifest: the exporter's `scene.json`, the two blocks the engine adds,
// and the defaults a legacy bundle falls through to.
//
// The fixture is a VERBATIM copy of a shipped bundle's `scene.json`
// (aos-threejs-poc/public/assets/ogs/myra/scene.json @ cdd63b10), because every default
// in the parser exists to keep such a bundle rendering exactly as it did — and a
// hand-written fixture would drift towards whatever the parser happens to do.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { GNM_DIM, parseExpressionSpace, parseRigManifest } from './assets/characterManifest.js';
import {
  isMultiRegionScene,
  multiRegionFileList,
  multiRegionOptionalFileList,
  multiRegionRigParamsList,
  parseSceneManifest,
  sceneNeedsRigDeform,
  singleRegionScene,
  fp16NameFor,
} from './assets/sceneManifest.js';

const scene: unknown = JSON.parse(
  readFileSync(new URL('../test/fixtures/bundle/scene.json', import.meta.url), 'utf8'),
);

describe('scene.json', () => {
  it('recognises a multi_region bundle', () => {
    expect(isMultiRegionScene(scene)).toBe(true);
    expect(isMultiRegionScene({ mode: 'multi_region' })).toBe(false); // no branches
    expect(isMultiRegionScene(null)).toBe(false);
  });

  it('parses the shipped fixture', () => {
    const manifest = parseSceneManifest(scene);
    expect(manifest.subject).toBe('myra');
    expect(manifest.schemaVersion).toBe('2');
    expect(manifest.numPoses).toBe(30);
    // BRANCH_ORDER puts head first; `eyes` is declared and follows.
    expect(manifest.order).toEqual(['head', 'eyes']);
    expect(manifest.branches.head.uvRes).toBe(256);
    expect(manifest.branches.head.rigDim).toBe(168);
    expect(manifest.branches.head.trunk).toBe('trunk_head.onnx');
    expect(manifest.branches.head.rigParams).toBe('rig_params_head.npy');
  });

  it('keeps the direction-only plücker default', () => {
    // The moment channels encode absolute camera position, which appr can overfit to
    // the capture rig — so an undeclared moment_scale is 0, never 1.
    const manifest = parseSceneManifest(scene);
    expect(manifest.momentScale).toBe(0);
    expect(manifest.worldScale).toBe(1);
    expect(manifest.worldOffset).toEqual([0, 0, 0]);
    expect(manifest.worldRotation).toEqual([0, 0, 0]);
    expect(manifest.rigRange).toEqual([-3, 3]);
  });

  it('defaults the out-of-ONNX lift parameters to their inert values', () => {
    // Every one of these is applied by the trainer AFTER the decoder, so the lift has
    // to apply it too — and an absent value must lift BYTE-IDENTICALLY to a bundle
    // exported before the flag existed, never at a guessed trainer constant.
    const head = parseSceneManifest(scene).branches.head;
    expect(head.scaleLogBias).toBe(0);
    expect(head.triKappa).toBe(0);
    expect(head.sliverQMin).toBe(0);
    expect(head.sigmaMax).toBe(0);
    expect(head.uvErode).toBe(0);
  });

  it('applies the trainer ceiling only to a bundle that declares a bias', () => {
    // scale_log_max falls back to the trainer constant ONLY when scale_log_bias marks a
    // v5-era export; every older bundle lifted unclamped and must keep doing so.
    const withBias = parseSceneManifest(scene).branches.head;
    expect(withBias.scaleLogMax).toBe(4);

    const noBias = structuredClone(scene) as { branches: Record<string, Record<string, unknown>> };
    delete noBias.branches.head.scale_log_bias;
    expect(parseSceneManifest(noBias).branches.head.scaleLogMax).toBe(Infinity);

    // `clothes` is tighter than every other branch, because its decoder is the one that
    // was seen spiking.
    const clothes = structuredClone(scene) as {
      branches: Record<string, Record<string, unknown>>;
    };
    clothes.branches.clothes = { ...clothes.branches.head };
    expect(parseSceneManifest(clothes).branches.clothes.scaleLogMax).toBe(3);
  });

  it('reads the gaze-conditioned branch as the eye system, not a mesh branch', () => {
    const eyes = parseSceneManifest(scene).branches.eyes;
    expect(eyes.gazeConditioned).toBe(true);
    expect(eyes.rigDim).toBe(0);
    expect(eyes.meshJson).toBeUndefined();
    expect(eyes.statics?.meta).toBe('eye_meta.json');
    expect(eyes.eyeMesh).toEqual({ glb: 'head_eyes.glb', json: 'head_eyes.json' });
  });

  it('refuses a branch that merely forgot its trunk', () => {
    const broken = structuredClone(scene) as {
      branches: Record<string, Record<string, unknown>>;
      trunks?: unknown;
    };
    delete broken.branches.head.trunk;
    delete broken.trunks;
    expect(() => parseSceneManifest(broken)).toThrow(/missing 'trunk'/);
  });

  it('exempts an explicitly FUSED branch from needing a trunk', () => {
    const fused = structuredClone(scene) as {
      branches: Record<string, Record<string, unknown>>;
      trunks?: unknown;
    };
    delete fused.branches.head.trunk;
    delete fused.trunks;
    fused.branches.head.fused = true;
    expect(parseSceneManifest(fused).branches.head.trunk).toBeUndefined();
  });

  it('lists the eager, optional and rig-param files', () => {
    const required = multiRegionFileList(scene);
    expect(required).toContain('mesh_head.bin');
    expect(required).toContain('trunk_head.onnx');
    expect(required).toContain('eye_static_left.bin');
    // A branch's rig2mesh is NEVER required: the exact rig replaces it and cost ~74 MB.
    expect(required.every((f) => !f.includes('rig2mesh'))).toBe(true);
    expect(multiRegionOptionalFileList(scene)).toContain('geom_head_fp16.onnx');
    expect(multiRegionRigParamsList(scene)).toEqual(['rig_params_head.npy']);
  });

  it('derives an fp16 sibling idempotently', () => {
    expect(fp16NameFor('geom_head.onnx')).toBe('geom_head_fp16.onnx');
    expect(fp16NameFor('geom_head_fp16.onnx')).toBe('geom_head_fp16.onnx');
    expect(fp16NameFor('mesh.bin')).toBeNull();
  });

  it('asks whether a bundle needs a rig STRUCTURALLY', () => {
    // Keyed on `fused`, not on whether a rig2mesh is declared: a bundle exported with
    // no rig2mesh is normal now, and keyed on the declaration such a bundle would
    // answer "needs no rig" while its head sat frozen.
    expect(sceneNeedsRigDeform(scene)).toBe(true);
    expect(sceneNeedsRigDeform({ branches: { head: { fused: true } } })).toBe(false);
    expect(sceneNeedsRigDeform({})).toBe(false);
  });
});

describe('singleRegionScene', () => {
  it('adapts a schema_version 1 bundle to a one-branch FUSED scene', () => {
    const adapted = singleRegionScene({ uvRes: 256, rigDim: 60, subject: 'isaac' });
    const manifest = parseSceneManifest(adapted);
    expect(manifest.order).toEqual(['head']);
    expect(manifest.branches.head.fused).toBe(true);
    expect(manifest.branches.head.trunk).toBeUndefined();
    expect(manifest.bodyRig).toBe('head');
    // world_scale / world_offset / moment_scale are NOT derivable from such a bundle,
    // so the synthesized manifest omits them and they fall through to the same
    // defaults every multi_region bundle gets.
    expect(manifest.worldScale).toBe(1);
    expect(manifest.momentScale).toBe(0);
    expect(manifest.branches.head.scaleLogBias).toBe(0);
    expect(sceneNeedsRigDeform(adapted)).toBe(false);
  });

  it('refuses a bad uv_res or rig_dim', () => {
    expect(() => singleRegionScene({ uvRes: 0, rigDim: 60 })).toThrow(/bad uv_res/);
    expect(() => singleRegionScene({ uvRes: 256, rigDim: 0 })).toThrow(/bad rig_dim/);
  });
});

describe('the engine-added manifest blocks', () => {
  const rigNames = ['CTRL_C_jaw.translateY', 'CTRL_L_eye_blink.translateY'];

  it('defaults a legacy bundle with a pack to the ORL backend', () => {
    const rig = parseRigManifest(scene, rigNames, { hasOrlPack: true, needsRig: true });
    expect(rig.backend).toBe('orl');
    expect(rig.pack).toBe('orl_pack.bin');
    expect(rig.controlNames).toEqual(rigNames);
  });

  it('reports `none` for a bundle with no rig at all', () => {
    const rig = parseRigManifest(scene, rigNames, { hasOrlPack: false, needsRig: true });
    expect(rig.backend).toBe('none');
    expect(rig.pack).toBeNull();
  });

  it('reports `none` for a FUSED bundle, which needs no rig', () => {
    const fused = singleRegionScene({ uvRes: 256, rigDim: 60 });
    const rig = parseRigManifest(fused, rigNames, { hasOrlPack: true, needsRig: false });
    expect(rig.backend).toBe('none');
  });

  it('reads a declared rig block', () => {
    const declared = {
      ...(scene as object),
      rig: { backend: 'gnm', pack: 'myra.aosrig', vertex_count: 17821 },
    };
    const rig = parseRigManifest(declared, rigNames, { hasOrlPack: false, needsRig: true });
    expect(rig.backend).toBe('gnm');
    expect(rig.pack).toBe('myra.aosrig');
    expect(rig.vertexCount).toBe(17821);
  });

  it('refuses an unknown backend rather than guessing', () => {
    const bad = { ...(scene as object), rig: { backend: 'rig2mesh' } };
    expect(() => parseRigManifest(bad, rigNames, { hasOrlPack: false, needsRig: true })).toThrow(
      /rig\.backend/,
    );
  });

  it('infers arkit52 for an ORL bundle and gnm for a GNM one', () => {
    const orl = parseRigManifest(scene, rigNames, { hasOrlPack: true, needsRig: true });
    expect(parseExpressionSpace(scene, orl)).toMatchObject({ kind: 'arkit52', dim: 52 });

    const gnmScene = { ...(scene as object), rig: { backend: 'gnm', pack: 'myra.aosrig' } };
    const gnm = parseRigManifest(gnmScene, rigNames, { hasOrlPack: false, needsRig: true });
    const space = parseExpressionSpace(gnmScene, gnm);
    expect(space.kind).toBe('gnm');
    expect(space.dim).toBe(GNM_DIM);
    // The segments are what tells an animator which slice is which.
    expect(space.segments.map((s) => s.name)).toEqual([
      'left_eye',
      'right_eye',
      'lower_face',
      'tongue',
      'pupils',
      'gaze',
    ]);
    expect(space.segments.at(-1)).toEqual({ name: 'gaze', start: 383, count: 4 });
  });

  it('reads a declared expression space, segments and all', () => {
    const declared = {
      ...(scene as object),
      expression_space: {
        kind: 'gnm68',
        dim: 68,
        names: [],
        segments: [{ name: 'gaze', start: 64, count: 4 }],
        arkit_map: [0, 1, 2],
      },
    };
    const rig = parseRigManifest(declared, rigNames, { hasOrlPack: true, needsRig: true });
    const space = parseExpressionSpace(declared, rig);
    expect(space.kind).toBe('gnm68');
    expect(space.dim).toBe(68);
    expect(space.arkitMap).toEqual([0, 1, 2]);
  });
});
