// The ORL rig as CHARACTER assets.
//
// A baked ORL rig is identity-specific — it is that character's DNA, neutral mesh,
// skin weights and blendshape deltas — so it belongs in the character's own bundle,
// not in the engine. It ships as ONE packed file (`./orlPack.ts`) carrying every
// baked member, under an `orl_` prefix so it cannot collide with the bundle's own
// names.
//
// (`vendor/riglogic.wasm` is the other half and is the opposite: identity-
// INDEPENDENT code that ships with the engine. No baked rig is ever committed.)
//
// Ported from aos-threejs-poc/src/lib/orl/bundleFiles.js @ cdd63b10

/**
 * Members inside the pack, in the deformer's expected key order.
 *
 * This is the bake's output list — the packer writes exactly these, in this order,
 * which is part of the container's byte-identity contract. `mesh_idx.bin` rides
 * along for completeness; nothing at runtime reads it (the branch owns its own
 * topology).
 */
export const ORL_BUNDLE_FILES = [
  'manifest.json',
  'bs_targets.json',
  'head_behavior.dna',
  'neutral_pos.bin',
  'joint_neutral.bin',
  'joint_parents.bin',
  'inverse_bind.bin',
  'skin_idx.bin',
  'skin_w.bin',
  'bs_index.bin',
  'bs_delta.bin',
  'mesh_idx.bin',
] as const;

/** Members the deformer + rig actually need — what a pack must carry to be usable. */
export const ORL_REQUIRED_MEMBERS: string[] = ORL_BUNDLE_FILES.filter((f) => f !== 'mesh_idx.bin');

/** The packed bundle's filename inside the pack namespace. */
export const ORL_PACK_FILE = 'pack.bin';

/**
 * Bundle-side asset name: `pack.bin` -> `orl_pack.bin`.
 *
 * @param file A pack-namespace filename, such as `ORL_PACK_FILE`.
 * @returns The same name under the bundle's `orl_` prefix.
 */
export const orlAssetName = (file: string): string => `orl_${file}`;

/**
 * Every ORL asset name, for the loader's optional-file list.
 *
 * @returns The single-element list holding the packed bundle's asset name.
 */
export const orlBundleAssetNames = (): string[] => [orlAssetName(ORL_PACK_FILE)];

/**
 * True when a bundle carries the ORL pack. One file, so a partial upload is no
 * longer expressible — the pack either parses or it throws.
 *
 * @param hasFile Presence predicate over the bundle's asset names.
 * @returns True when the bundle carries `orl_pack.bin`.
 */
export function hasOrlBundle(hasFile: (name: string) => boolean): boolean {
  return hasFile(orlAssetName(ORL_PACK_FILE));
}
