// Per-branch mesh topology for a multi_region bundle; the decoder chain fetches
// the ONNX itself.
//
// Ported from aos-threejs-poc/src/ogs/assets/loadMultiRegionScene.ts @ cdd63b10

import { loadBranchMesh, type MeshAssets, type MeshSource } from './loader.js';
import { parseNpyFloat32 } from '../npyFloat32.js';
import { parseSceneManifest, type SceneManifest, type BranchSpec } from './sceneManifest.js';

export interface BranchAssets {
  name: string;
  spec: BranchSpec;
  mesh: MeshAssets;
  uvRes: number;
  rigDim: number;
  /**
   * The rig the branch's `neutral_vertices` were exported at — row 0 of its rig params,
   * training's reference pose. Null only when the bundle ships none.
   *
   * This is NOT a zero vector and cannot be replaced by one. A myra head's control space
   * is 3 + 7 per bone (root translation, then a parent-relative quaternion and a scale per
   * bone — myra_v2_build_rig.py), so its rest value is a UNIT QUATERNION per bone. Zeroing
   * it hands the trunk a vector tens of units from anything it trained on and the code
   * latent comes out far wider than the decoder ever saw: what renders is a recognisable
   * face smeared by oversized, over-stretched splats.
   */
  referenceRig: Float32Array | null;
}

export interface MultiRegionScene {
  manifest: SceneManifest;
  branches: BranchAssets[]; // in manifest.order
  numPoses: number;
}

/**
 * Row 0 of the branch's declared rig params, or null when it declares none.
 *
 * @param source Byte accessors over the bundle.
 * @param spec The branch's scene.json entry; `rigParams` names the `.npy` and
 * `rigDim` is the control-space width the row must match exactly.
 * @returns The reference rig as one row of `rigDim` controls, or null when the
 * bundle declares no rig params or the file cannot be read — the latter warns, and
 * leaves the caller to decode the neutral at an all-zero rig instead.
 */
async function loadReferenceRig(
  source: MeshSource,
  spec: BranchSpec,
): Promise<Float32Array | null> {
  if (!spec.rigParams) return null;
  try {
    const { data, rows, cols } = parseNpyFloat32(
      new Uint8Array(await source.bytes(spec.rigParams)),
    );
    if (!rows) throw new Error(`${spec.rigParams} has no rows`);
    // WIDTH MUST MATCH the control space. A narrower row would be zero-padded downstream,
    // re-introducing the very off-distribution rig this reference exists to avoid.
    if (cols !== spec.rigDim) {
      throw new Error(
        `${spec.rigParams} is ${String(cols)} controls, branch rig_dim is ${String(spec.rigDim)}`,
      );
    }
    return data.slice(0, cols);
  } catch (cause) {
    // Labelled, never silent: the caller falls back to a zero rig, which decodes an
    // off-distribution neutral rather than nothing at all, so the reason has to be visible
    // rather than inferred from a wrong-looking face. Uploading the file is the fix.
    console.warn(
      `[character] branch '${spec.name}': cannot read '${spec.rigParams}' — decoding the ` +
        "neutral at an all-zero rig, which is NOT this branch's rest pose",
      cause,
    );
    return null;
  }
}

/**
 * Skips gaze-conditioned branches: the eye system consumes their spec directly.
 *
 * @param source Byte and JSON accessors over the bundle.
 * @param sceneJson The bundle's raw `scene.json`, parsed and validated here.
 * @returns The parsed manifest, one `BranchAssets` per non-gaze branch in
 * `manifest.order`, and the bundle's pose count.
 */
export async function loadMultiRegionScene(
  source: MeshSource,
  sceneJson: unknown,
): Promise<MultiRegionScene> {
  const manifest = parseSceneManifest(sceneJson);
  const branches: BranchAssets[] = [];
  for (const name of manifest.order) {
    const spec = manifest.branches[name];
    if (spec.gazeConditioned) continue;
    // `parseSceneManifest` requires both on every non-gaze branch, so an absent one here
    // is a parser change rather than a bad bundle — say which.
    if (!spec.meshJson || !spec.meshBin) {
      throw new Error(`scene.json branch '${name}' has no mesh files but is not gaze-conditioned`);
    }
    const mesh = await loadBranchMesh(source, spec.meshJson, spec.meshBin);
    const referenceRig = await loadReferenceRig(source, spec);
    branches.push({ name, spec, mesh, uvRes: spec.uvRes, rigDim: spec.rigDim, referenceRig });
  }
  return { manifest, branches, numPoses: manifest.numPoses };
}
