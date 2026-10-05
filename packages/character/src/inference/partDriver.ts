// The part-GLB vertex source for a multi-region OGS bundle: PartRigDrive skins each
// part from one shared clip, PartBranchVertices scatters the result into branch-vertex
// order, and the branch lifts at those verts with its decoder outputs frozen.
//
// Per part, never a fused rig: a union skeleton gives the clip duplicate bone names to
// bind against and picks one arbitrarily.
//
// Ported from aos-threejs-poc/src/ogs/inference/partDriver.js @ cdd63b10. The
// `?partrig=` / `?partclip=` URL overrides are dropped — assets are addressed by id
// here — and `loadPartDriver` takes BYTES rather than URLs for the same reason.

import { loadPartRigFromGlb, type GlbSource, type PartRigDrive } from './partRigDrive.js';
import { PartBranchVertices, type BranchTarget, type NamedPartFit } from './partBranchVertices.js';

/** The multi-part rig: one skinned mesh per body part over a SINGLE bone hierarchy. */
export const PART_DRIVER_RIG = 'rig.glb';

/** The clip every part binds, by bone name. */
export const PART_DRIVER_CLIP = 'macarena.glb';

/** Every bundle file a part drive needs. */
export const PART_DRIVER_FILES: string[] = [PART_DRIVER_RIG, PART_DRIVER_CLIP];

/**
 * Which part-driver files a bundle lacks. Empty = drivable.
 *
 * @param hasFile Membership test against the bundle, by file name.
 * @returns The entries of `PART_DRIVER_FILES` the bundle does not carry, in that order.
 */
export function missingPartDriverFiles(hasFile: (name: string) => boolean): string[] {
  return PART_DRIVER_FILES.filter((name) => !hasFile(name));
}

/**
 * Whether a bundle carries the whole part drive. Partial is never offered — a missing
 *  part throws in PartBranchVertices, and a drive that can't build is worse than none.
 *
 * @param hasFile Membership test against the bundle, by file name.
 * @returns `true` only when both the rig GLB and the clip GLB are present.
 */
export function bundleHasPartDriver(hasFile: (name: string) => boolean): boolean {
  return missingPartDriverFiles(hasFile).length === 0;
}

/**
 * Why a bundle gets no part drive, or null when it has one — or when it carries NEITHER
 *  file and simply isn't an animated bundle. Only a HALF-present driver is a mistake, and
 *  it has to name the missing file: without this the clip is just absent from the Anim
 *  panel, which reads identically to a bundle that never shipped one.
 *
 * @param hasFile Membership test against the bundle, by file name.
 * @returns A sentence naming what is present and what is missing, or `null` when the bundle
 *   carries all of the files or none of them.
 */
export function partDriverGap(hasFile: (name: string) => boolean): string | null {
  const missing = missingPartDriverFiles(hasFile);
  if (!missing.length || missing.length === PART_DRIVER_FILES.length) return null;
  const present = PART_DRIVER_FILES.filter((name) => !missing.includes(name));
  return `bundle ships ${present.join(', ')} but not ${missing.join(', ')} — no body animation`;
}

// A correct frame conversion lands within the bind-vs-trained-neutral pose difference,
// which is centimetres. A wrong axis or a centimetre/metre slip lands a metre out, so
// anything past this is a frame error and not a pose difference.
const MAX_NEUTRAL_RESIDUAL_METRES = 0.25;

/** How well one branch's parts fit the branch they drive. */
export interface PartDriverBranchFit {
  name: string;
  residual: { mean: number; max: number } | null;
  disagreement: number | null;
  parts: { name: string; translation: number[]; residualMean: number; residualMax: number }[];
}

/**
 * How well the loaded parts fit the branches they drive, per branch.
 *
 * @param verts The built scatter, whose `branches` map decides which branches are reported.
 * @returns One entry per branch: the neutral residual in metres, the corner disagreement,
 *   and each part's solved translation and residuals.
 */
export function partDriverFit(verts: PartBranchVertices): PartDriverBranchFit[] {
  return [...verts.branches.keys()].map((name) => ({
    name,
    residual: verts.neutralResidual(name),
    disagreement: verts.maxDisagreement(name),
    // Each part's solved FBX->branch frame. The TRANSLATIONS differ per part (head 55 mm,
    // sweater 32 mm, body 22 mm), which is why one shared conversion renders the body and
    // breaks the head — see partFrameFit.js.
    parts:
      verts.partFits(name)?.map((fit: NamedPartFit) => ({
        name: fit.name,
        translation: [...fit.translation],
        residualMean: fit.residualMean,
        residualMax: fit.residualMax,
      })) ?? [],
  }));
}

/**
 * `mean=12.3mm max=45.6mm spread=0.000006` — one line per branch, for the log/panel.
 *
 * @param branch One branch's fit, from {@link partDriverFit}.
 * @returns The one-line report, distances in millimetres, with the per-part summaries in
 *   brackets when the branch has any.
 */
export function formatPartDriverFit(branch: PartDriverBranchFit): string {
  const millimetres = (metres: number) => `${(metres * 1000).toFixed(1)}mm`;
  const parts = branch.parts
    .map(
      (part) =>
        `${part.name.replace(/^SK_sweaterRollerSkate_|^SKM_MHC_Myra_/, '')} ` +
        `+${(part.translation[1] * 1000).toFixed(0)}mm@${millimetres(part.residualMean)}`,
    )
    .join(' ');
  return (
    `${branch.name}: neutral mean=${millimetres(branch.residual?.mean ?? 0)} ` +
    `max=${millimetres(branch.residual?.max ?? 0)} spread=${millimetres(branch.disagreement ?? 0)}` +
    (parts ? `  [${parts}]` : '')
  );
}

/** What a loaded part drive carries. */
export interface PartDriver {
  rig: PartRigDrive;
  verts: PartBranchVertices;
  fit: PartDriverBranchFit[];
}

/**
 * Bind the multi-part rig + clip to `branchMeshes`, and refuse a bad fit.
 *
 * @param options The two GLBs and the branches they drive.
 * @param options.rigGlb `rig.glb` as bytes — one skinned mesh per part over a single
 *   bone hierarchy.
 * @param options.clipGlb The clip GLB as bytes; its first animation is the one played.
 * @param options.branchMeshes The trained branches keyed by name, each supplying `faces`,
 *   `neutralVertices` and the vertex count.
 * @returns The bound rig, the branch-vertex scatter, and the per-branch fit report; the rig
 *   is disposed and an error thrown when any branch sits further than 0.25 m from its
 *   trained neutral, which means the parts are not in the branch frame.
 */
export async function loadPartDriver({
  rigGlb,
  clipGlb,
  branchMeshes,
}: {
  rigGlb: GlbSource;
  clipGlb: GlbSource;
  branchMeshes: Record<string, BranchTarget>;
}): Promise<PartDriver> {
  const rig = await loadPartRigFromGlb(rigGlb, clipGlb);
  const verts = new PartBranchVertices(rig.meshes, branchMeshes);
  const fit = partDriverFit(verts);
  const wrong = fit.filter((branch) => (branch.residual?.mean ?? 0) > MAX_NEUTRAL_RESIDUAL_METRES);
  if (wrong.length) {
    rig.dispose();
    throw new Error(
      'partDriver: ' +
        wrong
          .map((branch) => `'${branch.name}' sits ${(branch.residual?.mean ?? 0).toFixed(2)}m`)
          .join(', ') +
        ' from the trained neutral — the parts are not in the branch frame',
    );
  }
  return { rig, verts, fit };
}
