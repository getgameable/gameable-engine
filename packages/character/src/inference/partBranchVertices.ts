// Branch vertices straight off the part meshes' own skinning — no association, no
// nearest-neighbour search.
//
// A part GLB and its trained branch are the SAME geometry. The GLB is non-indexed (one
// position per triangle corner) and the branch mesh's `faces` entry at corner c IS that
// corner's branch-vertex index, so the remap is a scatter:
//
//     branchVertex[ faces[c] ] = skinnedPartCorner[c]
//
// Corners sharing a branch vertex must land on the same position. `maxDisagreement`
// reports that spread — near zero proves the part ORDER matches what the branch was
// trained on, and a large value means the scatter is binding unrelated vertices.
//
// FRAME, AND IT IS PER PART. A part GLB carries the artist's FBX frame — centimetres,
// Z up — while a trained branch mesh is metres in the export's own frame, which the
// manifest's world_rotation turns upright at render time. Training solves that conversion
// SEPARATELY FOR EACH PART (build_v5_meshes.py's get_part: a signed axis permutation plus
// a translation, frozen at pose 0), so one shared conversion is right for whichever part
// it was derived from and offset for the rest — head by 55 mm, sweater 32 mm, body 22 mm.
// On a 1.2 m torso 22 mm hides inside the bind-vs-neutral pose difference and the body
// looks fine; on a 0.33 m head 55 mm does not. So each part solves its own
// (partFrameFit.ts) and `neutralResidual` reports what it achieved: maxDisagreement
// compares corners only against each other, so it reads ~0 even when every vertex is in
// the wrong frame entirely.
//
// Ported from aos-threejs-poc/src/ogs/inference/partBranchVertices.js @ cdd63b10

import { Matrix4, Vector3 } from 'three/webgpu';
import type { SkinnedMesh } from 'three/webgpu';

import {
  PART_FIT_MAX_RESIDUAL_METRES,
  applyPartFrame,
  fitPartFrame,
  type PartFrameFit,
} from './partFrameFit.js';

/** The trained branch a set of part meshes drives. */
export interface BranchTarget {
  /** Branch vertex index per face corner. */
  faces: Uint32Array;
  /** The branch's trained neutral vertices, `(V,3)`. */
  neutralVertices: Float32Array;
  manifest: { num_vertices: number };
}

/** One part's solved fit, plus the name it was solved for. */
export type NamedPartFit = PartFrameFit & { name: string };

/** A branch that could not be built, keyed out of the map rather than stored as null. */
interface BranchState {
  meshes: SkinnedMesh[];
  faces: Uint32Array;
  neutralVertices: Float32Array;
  fits: NamedPartFit[];
  out: Float32Array;
}

/** Part meshes per branch, in the order their corners concatenate. */
export const BRANCH_PARTS: Record<string, string[]> = {
  head: ['SKM_MHC_Myra_FaceMesh'],
  body: ['SKM_MHC_Myra_BodyMesh'],
  clothes: [
    'SK_sweaterRollerSkate_sweater',
    'SK_sweaterRollerSkate_pants',
    'SK_sweaterRollerSkate_sneakers',
  ],
};

const CENTIMETRES_TO_METRES = 0.01;

/**
 * The axis convention every part solves to, as a matrix — for placing a driver mesh
 *  beside the Gaussians. Rotation and scale only: each part's own TRANSLATION is what
 *  differs, so this places the rig approximately and the per-part fits place the splats.
 *
 * @returns A fresh `Matrix4` carrying the centimetres-to-metres scale and the axis
 *   permutation, with no translation.
 */
export function partToBranchMatrix(): Matrix4 {
  const scale = CENTIMETRES_TO_METRES;
  return new Matrix4().set(0, -scale, 0, 0, 0, 0, -scale, 0, scale, 0, 0, 0, 0, 0, 0, 1);
}

/**
 * Skinned position of one corner, converted by that part's OWN solved fit.
 *
 * @param mesh The part mesh, posed by whatever is driving its skeleton.
 * @param index The corner index within that mesh's position attribute.
 * @param fit The part's solved FBX-to-branch transform.
 * @param target A reused `Vector3` to write into, so the per-frame loop allocates nothing.
 * @returns The same `target`, now the corner's branch-frame position in metres.
 */
function skinnedCorner(
  mesh: SkinnedMesh,
  index: number,
  fit: PartFrameFit,
  target: Vector3,
): Vector3 {
  target.fromBufferAttribute(mesh.geometry.attributes.position, index);
  mesh.applyBoneTransform(index, target);
  return applyPartFrame(fit, target);
}

/**
 * Each part's solved FBX→branch fit, in corner order, refusing a fit that isn't one.
 *
 * @param branch The branch name, quoted in the error when a part fits badly.
 * @param meshes The part meshes, in the order their corners concatenate.
 * @param partNames Their file names, parallel to `meshes`.
 * @param target The trained branch the parts drive, supplying `faces` and the neutral verts.
 * @returns One fit per part, each tagged with its name; throws when any part's mean residual
 *   exceeds `PART_FIT_MAX_RESIDUAL_METRES`.
 */
function fitParts(
  branch: string,
  meshes: SkinnedMesh[],
  partNames: string[],
  target: BranchTarget,
): NamedPartFit[] {
  const fits: NamedPartFit[] = [];
  let firstCorner = 0;
  for (let index = 0; index < meshes.length; index++) {
    const positions = meshes[index].geometry.attributes.position as {
      array: Float32Array;
      count: number;
    };
    // The BIND pose: applyBoneTransform is the identity there, so the raw attribute is
    // the pose training solved against (get_part's `p.skin(p.pose_of(0))`).
    const corners = positions.array.subarray(0, positions.count * 3);
    const fit = fitPartFrame(corners, target.faces, firstCorner, target.neutralVertices);
    if (fit.residualMean > PART_FIT_MAX_RESIDUAL_METRES) {
      throw new Error(
        `partBranchVertices: branch '${branch}' part '${partNames[index]}' fits its trained ` +
          `vertices no better than ${(fit.residualMean * 1000).toFixed(0)}mm — that is not a ` +
          'frame convention, it is the wrong part or the wrong corner order',
      );
    }
    fits.push({ name: partNames[index], ...fit });
    firstCorner += positions.count;
  }
  return fits;
}

export class PartBranchVertices {
  // A Map, not an index signature: a branch the bundle does not declare is the
  // ORDINARY case (a bundle with no clothes), and `record[key]` types as present, so
  // every "no such branch" return would read as dead code.
  readonly branches: Map<string, BranchState>;
  private readonly _point: Vector3;

  /**
   * @param partMeshes `{ [partName]: SkinnedMesh }`, keyed on the part FILE name.
   * @param branchMeshes `{ [branch]: { faces, neutralVertices, manifest } }`.
   * @param branchParts Branch -> part names, in corner-concatenation order.
   */
  constructor(
    partMeshes: Record<string, SkinnedMesh>,
    branchMeshes: Record<string, BranchTarget>,
    branchParts: Record<string, string[]> = BRANCH_PARTS,
  ) {
    this.branches = new Map();
    const partsByName = new Map(Object.entries(partMeshes));
    const targets = new Map(Object.entries(branchMeshes));
    for (const [branch, partNames] of Object.entries(branchParts)) {
      const target = targets.get(branch);
      if (!target) continue;
      const meshes = partNames.map((name) => {
        const mesh = partsByName.get(name);
        if (!mesh)
          throw new Error(`partBranchVertices: no part mesh '${name}' for branch '${branch}'`);
        return mesh;
      });
      const corners = meshes.reduce(
        (sum, mesh) => sum + mesh.geometry.attributes.position.count,
        0,
      );
      if (corners !== target.faces.length) {
        throw new Error(
          `partBranchVertices: branch '${branch}' has ${String(corners)} part corners but the trained ` +
            `mesh has ${String(target.faces.length)} (${String(target.faces.length / 3)} faces) — not the same geometry`,
        );
      }
      this.branches.set(branch, {
        meshes,
        faces: target.faces,
        neutralVertices: target.neutralVertices,
        fits: fitParts(branch, meshes, partNames, target),
        out: new Float32Array(target.manifest.num_vertices * 3),
      });
    }
    this._point = new Vector3();
  }

  /**
   * Skin the parts at their current pose and scatter into branch-vertex order.
   *
   * @param branch Which branch to deform.
   * @returns The reused `(V,3)` flat xyz buffer of branch-frame vertices in metres, valid
   *   until the next call, or `null` when this bundle declares no such branch.
   */
  deform(branch: string): Float32Array | null {
    const state = this.branches.get(branch);
    return state ? this.deformState(state) : null;
  }

  /**
   * `deform`, once the branch is known to exist.
   *
   * @param state That branch's meshes, fits, face map and output buffer.
   * @returns `state.out`, filled with the skinned branch-frame vertices.
   */
  private deformState(state: BranchState): Float32Array {
    const { meshes, faces, fits, out } = state;
    const point = this._point;
    let corner = 0;
    for (let part = 0; part < meshes.length; part++) {
      const mesh = meshes[part];
      const fit = fits[part];
      const count = mesh.geometry.attributes.position.count;
      for (let index = 0; index < count; index++, corner++) {
        skinnedCorner(mesh, index, fit, point);
        const vertex = faces[corner] * 3;
        out[vertex] = point.x;
        out[vertex + 1] = point.y;
        out[vertex + 2] = point.z;
      }
    }
    return out;
  }

  /**
   * Each part's solved fit for `branch` — the frame contract, for the log/panel.
   *
   * @param branch Which branch to report on.
   * @returns Its parts' fits in corner order, or `null` when there is no such branch.
   */
  partFits(branch: string): NamedPartFit[] | null {
    return this.branches.get(branch)?.fits ?? null;
  }

  /**
   * Distance from the CURRENT pose to the branch's trained neutral, metres.
   *
   *  Read at the bind pose this is the frame check: the part GLB and the branch are the
   *  same geometry, so a correct conversion lands within the bind-vs-neutral pose
   *  difference (centimetres) while a wrong axis or scale lands a metre out.
   *
   * @param branch Which branch to measure; it is deformed at its current pose first.
   * @returns The mean and worst per-vertex distance to the trained neutral, in metres, or
   *   `null` when there is no such branch.
   */
  neutralResidual(branch: string): { mean: number; max: number } | null {
    const state = this.branches.get(branch);
    if (!state) return null;
    const posed = this.deformState(state);
    const neutral = state.neutralVertices;
    const count = neutral.length / 3;
    let worst = 0;
    let sum = 0;
    for (let vertex = 0; vertex < count; vertex++) {
      const base = vertex * 3;
      const distance = Math.hypot(
        posed[base] - neutral[base],
        posed[base + 1] - neutral[base + 1],
        posed[base + 2] - neutral[base + 2],
      );
      sum += distance;
      if (distance > worst) worst = distance;
    }
    return { mean: sum / count, max: worst };
  }

  /**
   * Largest spread between corners sharing a branch vertex, in metres.
   *
   * @param branch Which branch to check; its parts are skinned at their current pose.
   * @returns The worst per-axis disagreement between corners that scatter to the same branch
   *   vertex — near zero proves the corner order matches training — or `null` when there is
   *   no such branch.
   */
  maxDisagreement(branch: string): number | null {
    const state = this.branches.get(branch);
    if (!state) return null;
    const { meshes, faces, fits, out } = state;
    const seen = new Float32Array(out.length);
    const written = new Uint8Array(out.length / 3);
    const point = this._point;
    let worst = 0;
    let corner = 0;
    for (let part = 0; part < meshes.length; part++) {
      const mesh = meshes[part];
      const fit = fits[part];
      const count = mesh.geometry.attributes.position.count;
      for (let index = 0; index < count; index++, corner++) {
        skinnedCorner(mesh, index, fit, point);
        const vertex = faces[corner];
        const base = vertex * 3;
        if (written[vertex]) {
          worst = Math.max(
            worst,
            Math.abs(seen[base] - point.x),
            Math.abs(seen[base + 1] - point.y),
            Math.abs(seen[base + 2] - point.z),
          );
          continue;
        }
        written[vertex] = 1;
        seen[base] = point.x;
        seen[base + 1] = point.y;
        seen[base + 2] = point.z;
      }
    }
    return worst;
  }
}
