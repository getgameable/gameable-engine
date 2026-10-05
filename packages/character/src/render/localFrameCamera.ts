import { Matrix4, Object3D, PerspectiveCamera, Quaternion, Vector3 } from 'three/webgpu';

/**
 * localFrameCamera — express the world camera in a splat avatar's LOCAL frame.
 *
 * WHY THIS EXISTS. A splat avatar's appearance is view-dependent neural
 * inference: the appearance decoder is fed plücker rays built from the camera
 * pose, and the training frame is the avatar's own. Both plücker paths
 * (computePluckerRays and GpuPlucker.compute) read exactly four things off the
 * camera — getFramePosition(), quaternion, fov, aspect — and were handed the
 * raw scene camera, which silently assumes **avatar frame == world frame**.
 *
 * That assumption held only because the splats were added straight to the scene
 * at the origin. Once the avatar can be moved, rotated or scaled by the game,
 * feeding the world camera would describe a viewer
 * that isn't where the decoder thinks it is: the geometry would move correctly
 * while the SHADING went quietly wrong — worst under rotation. Silent
 * corruption, no error.
 *
 * So: take the camera into the avatar root's local space first. The root's
 * inverse world matrix also divides out any avatar scale, which is exactly
 * right — the splats inside the group are still in their pre-scale training
 * frame, and `originScale` continues to handle the bundle's own cm->m factor
 * independently.
 *
 * The returned object is a duck-typed stand-in, not a real Camera: it exposes
 * only the four members both plücker implementations touch. It is REUSED across
 * frames (no allocation on the inference path), so treat the result as valid only
 * until the next update() call.
 *
 * Ported from aos-threejs-poc/src/ogs/render/localFrameCamera.ts @ cdd63b10
 */
export class LocalFrameCamera {
  fov = 50;
  aspect = 1;
  readonly quaternion = new Quaternion();

  private readonly _pos = new Vector3();
  private readonly _inv = new Matrix4();
  private readonly _rootQuat = new Quaternion();
  private readonly _scratchPos = new Vector3();
  private readonly _scratchScale = new Vector3();

  /**
   * The camera position in the avatar root's local frame.
   *
   * Named for the frame it returns, not for `Object3D.getWorldPosition` whose
   * contract it borrows. Calling it `getWorldPosition` made a raw scene camera a
   * structurally valid `PluckerCamera`, which is the one substitution this whole
   * class exists to make impossible.
   *
   * @param target The vector to write into; overwritten, never read.
   * @returns `target`, now holding the camera position in the avatar root's local
   * frame.
   */
  getFramePosition(target: Vector3): Vector3 {
    return target.copy(this._pos);
  }

  /**
   * Re-express `camera` in `root`'s local frame.
   *
   * Pass root = null (or an identity root) and this reduces to the camera's own
   * world pose, so the untransformed case is bit-identical to what the pipeline
   * did before.
   *
   * @param camera The scene camera the frame is actually being rendered from; only
   * its world position, world orientation, `fov` and `aspect` are read.
   * @param root The avatar root whose `matrixWorld` defines the local frame, or
   * null to keep the camera's world pose unchanged.
   * @returns This same reused instance — valid only until the next `update()`.
   */
  update(camera: PerspectiveCamera, root: Object3D | null): this {
    this.fov = camera.fov;
    this.aspect = camera.aspect;
    camera.getWorldPosition(this._pos);
    camera.getWorldQuaternion(this.quaternion);

    if (!root) return this;

    // `root.matrixWorld` MUST be fresh. The engine only updates matrices inside
    // `renderer.render`, which runs AFTER the character update, so reading it here
    // used to describe where the avatar was last frame — plücker rays one frame
    // stale, which during motion is view-dependent shading for a viewpoint that
    // never existed. `Character.update` calls `root.updateWorldMatrix(true, false)`
    // immediately before this. Decompose rather than assuming no scale.
    this._inv.copy(root.matrixWorld).invert();
    this._pos.applyMatrix4(this._inv);

    root.matrixWorld.decompose(this._scratchPos, this._rootQuat, this._scratchScale);
    // Local orientation = inverse(root) * world. Non-uniform root scale would
    // shear the basis and make "orientation" ill-defined; a character root only
    // ever carries uniform scale, so the quaternion is exact.
    this.quaternion.premultiply(this._rootQuat.invert());
    return this;
  }
}
