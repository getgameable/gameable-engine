// The bundle's world_rotation: the orientation of the TRAINING frame, undone at render time.
//
// A bundle is trained in whatever frame its capture rig used, and the decoders emit
// Gaussians in that frame — myra_v5's is 180° about Z from the scene's, so the lift is
// correct and the avatar still renders upside down. scene.json states the offending
// orientation as `world_rotation` (XYZ Euler degrees) and it is undone in the SAME two
// places world_offset is: the SplatMesh's own transform stands the splats up, and the
// plücker camera travels the INVERSE so appr is still conditioned on a camera in the frame
// it was trained in.
//
// Both halves or neither. Rotate only the mesh and the geometry stands up while the
// view-dependent shading quietly reads from a viewpoint 180° from the real one — no error,
// just wrong colour, which is the failure mode render/localFrameCamera.ts exists to
// document. Rotate only the camera and nothing moves at all.
//
// WHERE THIS APPLIES HERE, and it differs from the POC. The POC rotated each branch's
// own SplatMesh. One character is ONE splat object in this engine, so there is no
// per-branch node to turn: the rotation is baked into the lift instead
// (wgsl/lift_pass2_cov.wgsl applies it to both the centre and the covariance basis).
// Everything feeding the decoders — the branch's `neutralVertices`, the rig deform, the
// part fits — still lives in the trained frame, exactly as before.
//
// Ported from aos-threejs-poc/src/ogs/render/worldRotation.ts @ cdd63b10

import { Euler, Quaternion } from 'three/webgpu';

const DEGREES_TO_RADIANS = Math.PI / 180;

/**
 * scene.json `world_rotation` → a quaternion, or null when there is nothing to undo.
 *  Null rather than an identity quaternion so an unrotated bundle takes byte-identical
 *  paths to the ones it took before this existed.
 *
 * @param degrees The bundle's `world_rotation`: three XYZ Euler angles in degrees,
 * in XYZ order. Missing, wrong-length, non-finite and all-zero values all mean
 * "nothing to undo".
 * @returns The rotation that takes the training frame to the scene frame, or null
 * when the bundle was trained in the scene's own frame.
 */
export function worldRotationQuaternion(
  degrees: readonly number[] | undefined | null,
): Quaternion | null {
  if (!degrees || degrees.length !== 3) return null;
  const [x, y, z] = degrees;
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return null;
  if (x === 0 && y === 0 && z === 0) return null;
  const euler = new Euler(
    x * DEGREES_TO_RADIANS,
    y * DEGREES_TO_RADIANS,
    z * DEGREES_TO_RADIANS,
    'XYZ',
  );
  return new Quaternion().setFromEuler(euler);
}

/**
 * A quaternion as the `(w, x, y, z)` tuple the lift uniform takes.
 *
 * @param q The rotation to pack, typically {@link worldRotationQuaternion}'s result.
 * @returns The four components in `w, x, y, z` order — the lift's uniform layout,
 * which is not three.js's `x, y, z, w` — or the identity `[1, 0, 0, 0]` for null.
 */
export function quaternionToWxyz(q: Quaternion | null): [number, number, number, number] {
  return q ? [q.w, q.x, q.y, q.z] : [1, 0, 0, 0];
}
