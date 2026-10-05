// Forward kinematics on a body clip's bone hierarchy, reduced to ONE rigid
// transform: where the head bone has moved since its rest pose.
//
// The hair is rigid relative to the head, so it needs no skinning and no vertex
// correspondence — the head's own delta, applied to every hair vertex, is the whole
// drive. three does the FK: a mixer on the clip's hierarchy, then read the head
// bone's world matrix.
//
// FRAME. The clip GLB carries the artist's FBX frame (centimetres, a permuted axis
// convention) while the trained branch is metres in the export's frame, so the delta
// is CONJUGATED into the branch frame: `D_branch = C · D_glb · C⁻¹`, with
// `C = partToBranchMatrix`. Conjugation, not a one-sided multiply — a delta is a
// change of pose, not a point, so both sides have to change frame or the rotation
// axis comes out wrong while the translation looks plausible.
//
// Ported from aos-threejs-poc/src/ogs/branch/headRigidDrive.js @ cdd63b10 (the two
// pure halves; the `?hairclip=` URL override and the standalone clip loader are
// dropped — a game addresses assets by id).

import { Matrix4 } from 'three/webgpu';
import type { Object3D } from 'three/webgpu';

import { partToBranchMatrix } from './partBranchVertices.js';

/** The bone the hair rides. */
export const HEAD_BONE = 'head';

// The GLB <-> branch change of basis, built once: a delta is conjugated by it, never
// multiplied on one side (see the FRAME note above).
const TO_BRANCH = partToBranchMatrix();
const TO_GLB = TO_BRANCH.clone().invert();

/** The head bone plus its rest world inverse. */
export interface HeadRest {
  bone: Object3D;
  inverse: Matrix4;
}

/**
 * The head bone plus its REST world inverse, captured before any mixer poses `root`.
 *
 * Rest first is not a nicety: the delta is measured against the pose the hair's
 * trained neutral belongs to, and a mixer sitting at t=0 already holds the clip's
 * first frame.
 *
 * @param root The clip GLB's scene root, searched for the `head` node; its world matrices are
 *   updated here.
 * @param context A prefix for the error message when no head node is found, naming the asset
 *   that lacks one. Empty by default.
 * @returns The head bone and the inverse of its rest world matrix, both in the GLB's frame.
 */
export function captureHeadRest(root: Object3D, context = ''): HeadRest {
  // A one-element box, not a `let`: `traverse` takes a callback, and TS narrows a
  // closed-over `let` to its initial value for the code AFTER the call.
  const found: Object3D[] = [];
  root.traverse((n) => {
    if (!found.length && n.name === HEAD_BONE) found.push(n);
  });
  if (!found.length) {
    const names: string[] = [];
    root.traverse((n) => {
      if (n.name && names.length < 12) names.push(n.name);
    });
    throw new Error(`${context}no '${HEAD_BONE}' node (saw ${names.join(', ')}…)`);
  }
  root.updateMatrixWorld(true);
  const bone = found[0];
  return { bone, inverse: bone.matrixWorld.clone().invert() };
}

/**
 * Where the head has moved since rest, in the BRANCH frame. Caller poses `root` first.
 *
 * @param rest The head bone and rest inverse from {@link captureHeadRest}; the bone's current
 *   `matrixWorld` is what supplies the posed half.
 * @param out A `Matrix4` to write into, so the per-frame path allocates nothing.
 * @returns `out`, holding `C · (posed · rest⁻¹) · C⁻¹` — the delta conjugated into the branch
 *   frame, ready to push through `transformVertices`.
 */
export function headRigidDelta(rest: HeadRest, out: Matrix4 = new Matrix4()): Matrix4 {
  out.multiplyMatrices(rest.bone.matrixWorld, rest.inverse);
  return out.premultiply(TO_BRANCH).multiply(TO_GLB);
}
