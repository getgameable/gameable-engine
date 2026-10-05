// Compute plücker rays (1,6,1,H,W) for a pinhole camera. Mirrors the python
// implementation in `ae/view_encoding.py` — each pixel gets a ray
// (origin x direction, direction). The output is what `Plucker2Code` in the
// appearance decoder expects; the encoder internally bilinear-resizes whatever we
// pass to 512² -> 256² -> 128² before its convs, so this shape only has to match
// the ONNX input signature (H == mesh.manifest.uv_res).
//
// The first 3 plücker channels are the ray MOMENT (origin × direction), which
// encodes absolute camera position/scale. The appr decoder can overfit to the
// capture-rig moment distribution, so off-rig viewing cameras extrapolate to dark
// "black spot" colours. `momentScale` scales those channels: 1 = full plücker,
// 0 = direction-only — the DEFAULT, since a bundle that needs the moment channels
// can say so and one that silently omits the field cannot be assumed to want the
// overfit.
//
// The POC read the scale off a module-level `pluckerConfig` mutated by a `?moment=`
// URL flag; here it is an explicit argument threaded from the manifest, because a
// game has no URL to carry flags in and a mutable module global is a second source
// of truth the GPU path can disagree with.
//
// Ported from aos-threejs-poc/src/ogs/inference/plucker.ts @ cdd63b10

import { Quaternion, Vector3 } from 'three/webgpu';

/** Shared default so the no-offset call allocates nothing per frame. */
export const ORIGIN_ZERO: readonly number[] = Object.freeze([0, 0, 0]);

/**
 * The four members both plücker paths read off a camera.
 *
 * `getFramePosition`, not `getWorldPosition`: what the rays are built from is the
 * viewer expressed in the AVATAR's frame, and the old name let a raw scene camera
 * satisfy the type by accident — which is exactly the mistake
 * `render/localFrameCamera.ts` exists to prevent. A caller that really does want the
 * world frame passes a `LocalFrameCamera` updated against a null root.
 */
export interface PluckerCamera {
  fov: number;
  aspect: number;
  readonly quaternion: Quaternion;
  /**
   * The camera position in the avatar's local frame.
   *
   * @param target The vector to write into; overwritten, never read.
   * @returns `target`.
   */
  getFramePosition(target: Vector3): Vector3;
}

/**
 * Move a camera world position into the splat's local frame, IN PLACE.
 *
 * Only the OFFSET half lives here, deliberately: the CPU path then multiplies by
 * `originScale` itself while the GPU path passes `originScale` into the shader as
 * a uniform (which is what keeps `plucker.wgsl` byte-identical to its reference).
 * The subtraction is the part that has to agree, so it has exactly one definition
 * and both paths call it — parity by construction rather than by inspection.
 *
 * Order matters: subtract THEN scale. `(world - offset) * scale` is not
 * `world * scale - offset`; on a cm bundle those differ by a factor of 100.
 *
 * @param origin The camera world position, mutated in place.
 * @param worldOffset The bundle's `scene.json world_offset`; missing components read as 0,
 *   and the default leaves `origin` alone.
 * @returns The same `origin` object, now offset into the splat's frame.
 */
export function toLocalOrigin<T extends { x: number; y: number; z: number }>(
  origin: T,
  worldOffset: readonly number[] = ORIGIN_ZERO,
): T {
  origin.x -= worldOffset[0] ?? 0;
  origin.y -= worldOffset[1] ?? 0;
  origin.z -= worldOffset[2] ?? 0;
  return origin;
}

// Reused scratch for the world_rotation inverse — this runs once per branch per
// frame, and there is no allocation on the inference path.
const ROTATION_INVERSE = new Quaternion();

/**
 * Undo the splat's `world_rotation` on a camera pose, IN PLACE — the ORIENTATION
 * half of the trip `toLocalOrigin` makes, and both halves live in one call so
 * neither path can apply one without the other (`render/worldRotation.ts` says why
 * that would be silent).
 *
 * Order: AFTER `toLocalOrigin`, since the rotation is about the splat's own
 * origin. Uniform `originScale` commutes with it, so either side of the scale is
 * the same number. A null `worldRotation` (every bundle that declares none) leaves
 * the pose untouched.
 *
 * @param origin The already-offset camera position, rotated in place.
 * @param quaternion The camera orientation, premultiplied in place by the same inverse.
 * @param worldRotation The bundle's `scene.json world_rotation`; `null` (the default) is a
 *   no-op for both arguments.
 */
export function toLocalRotation(
  origin: Vector3,
  quaternion: Quaternion,
  worldRotation: Quaternion | null = null,
): void {
  if (!worldRotation) return;
  ROTATION_INVERSE.copy(worldRotation).invert();
  origin.applyQuaternion(ROTATION_INVERSE);
  quaternion.premultiply(ROTATION_INVERSE);
}

/** How a camera is expressed in one branch's trained frame. */
export interface PluckerFrame {
  /** `1 / worldScale` — the camera origin into the splat-local frame. */
  originScale?: number;
  /** `scene.json world_offset`, subtracted BEFORE `originScale`. */
  worldOffset?: readonly number[];
  /** `scene.json world_rotation` as a quaternion, inverted onto the camera. */
  worldRotation?: Quaternion | null;
  /** 1 = full plücker, 0 = direction-only (the default). */
  momentScale?: number;
}

/**
 * Plücker rays for `camera`, channel-major `(6, H, W)` flat —
 * `out[c*stride + (y*W + x)]`, c in 0..5 (moment.xyz then dir.xyz).
 *
 * `originScale` + `worldOffset` express the camera position in the splat's LOCAL
 * frame — the frame appr was trained in. The splat is placed at
 * `world = rotation·(local·worldScale) + worldOffset`, so the inverse a camera has
 * to travel is `local = R⁻¹(world - worldOffset) · originScale`.
 *
 * BOTH terms matter and only for the MOMENT: `dir` is invariant to translation and
 * to scale, so it is untouched, but the moment (origin × dir) is neither. Omitting
 * the offset conditions appr on a camera position it was never trained on. That
 * stayed invisible for as long as every bundle shipping a `world_offset` also
 * shipped `moment_scale` 0 (direction-only — translation-invariant, so the bug
 * could not express itself).
 *
 * Defaults (scale 1, offset 0, moment 0) are byte-identical to the untransformed
 * path.
 *
 * @param camera The viewing camera; its world position and quaternion are read, never mutated.
 * @param width Ray-grid width in texels, which must equal the decoder's `uv_res`.
 * @param height Ray-grid height in texels, likewise.
 * @param frame How this branch's trained frame relates to world: `originScale`, `worldOffset`,
 *   `worldRotation` and `momentScale`. An empty object gives the untransformed path.
 * @returns A fresh `Float32Array` of `6 * width * height` floats, channel-major: the three
 *   moment channels (already multiplied by `momentScale`) then the three unit-direction ones.
 */
export function computePluckerRays(
  camera: PluckerCamera,
  width: number,
  height: number,
  frame: PluckerFrame = {},
): Float32Array {
  const originScale = frame.originScale ?? 1;
  const momentScale = frame.momentScale ?? 0;
  const out = new Float32Array(6 * width * height);
  const origin = toLocalOrigin(camera.getFramePosition(new Vector3()), frame.worldOffset);
  // Copied, never the camera's own: `camera` is the reused LocalFrameCamera stand-in.
  const orientation = new Quaternion().copy(camera.quaternion);
  toLocalRotation(origin, orientation, frame.worldRotation ?? null);
  if (originScale !== 1) origin.multiplyScalar(originScale);
  const fovRad = (camera.fov * Math.PI) / 180;
  const tanFov = Math.tan(fovRad / 2);
  const aspect = camera.aspect;

  // Camera basis vectors in the splat's local frame.
  const forward = new Vector3(0, 0, -1).applyQuaternion(orientation);
  const right = new Vector3(1, 0, 0).applyQuaternion(orientation);
  const up = new Vector3(0, 1, 0).applyQuaternion(orientation);

  const dir = new Vector3();
  const moment = new Vector3();
  const stride = width * height;
  for (let y = 0; y < height; y++) {
    const ny = 1 - (2 * (y + 0.5)) / height; // flip Y so top = +1
    for (let x = 0; x < width; x++) {
      const nx = (2 * (x + 0.5)) / width - 1;
      dir
        .copy(forward)
        .addScaledVector(right, nx * tanFov * aspect)
        .addScaledVector(up, ny * tanFov)
        .normalize();
      moment.crossVectors(origin, dir);

      const idx = y * width + x;
      out[0 * stride + idx] = moment.x * momentScale;
      out[1 * stride + idx] = moment.y * momentScale;
      out[2 * stride + idx] = moment.z * momentScale;
      out[3 * stride + idx] = dir.x;
      out[4 * stride + idx] = dir.y;
      out[5 * stride + idx] = dir.z;
    }
  }
  return out;
}
