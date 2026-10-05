/** The character bridge's stateless helpers: loaders it imports on demand, and small maths. */
import { Object3D, Quaternion } from 'three/webgpu';
import type { PerspectiveCamera } from 'three/webgpu';
import type { JointOverride } from '@gameable/character';
import type { SkinnedGltf } from './types.js';

/**
 * The slice of `gameable/character`'s `Character` the decoder path drives.
 *
 * Spelled structurally rather than imported so that naming it does not make
 * `Character.ts` — and through it `onnxruntime-web` — statically reachable from
 * this module. The dynamic `import()` in `bootBundle` is the only reference.
 */
export interface BundleCharacter {
  /** The bundle's expression space. */
  readonly expressionSpace: { readonly kind: string; readonly dim: number };
  /**
   * Set the expression, in the bundle's own space.
   *
   * @param weights The weights.
   */
  setExpression(weights: Float32Array): void;
  /**
   * Aim the eyes at a world-space point.
   *
   * @param target The point, or null.
   */
  setLookAt(target: readonly [number, number, number] | null): void;
  /**
   * Pose the body: per-joint rotations by the rig's own joint names.
   *
   * @param pose The pose, or null for none.
   * @param pose.bones Per-joint parent-relative rotations as `(w, x, y, z)`.
   */
  setBodyPose(pose: { bones?: readonly JointOverride[] } | null): void;
  /**
   * Advance the character.
   *
   * @param dt Seconds since the previous frame.
   * @param camera The camera being rendered from.
   */
  update(dt: number, camera: PerspectiveCamera): void;
  /** Release the character. */
  dispose(): void;
}

/** The one `GLTFLoader` the default loader uses, built on first call. */
let gltfLoader: Promise<{ loadAsync(url: string): Promise<SkinnedGltf> }> | null = null;

/**
 * Load a skinned glTF with three's own loader, imported only when one is asked
 * for.
 *
 * No Draco and no KTX2: attaching a decoder would put a second download in
 * front of a path whose selling point is that it needs none. A game with a
 * compressed body passes {@link CharacterBridgeOptions.loadGltf} instead.
 *
 * @param url The URL to load.
 *
 * @returns The scene and its animations.
 */
export async function defaultLoadGltf(url: string): Promise<SkinnedGltf> {
  gltfLoader ??= import('three/addons/loaders/GLTFLoader.js').then(
    ({ GLTFLoader }) =>
      new GLTFLoader() as unknown as { loadAsync(u: string): Promise<SkinnedGltf> },
  );
  const loader = await gltfLoader;
  const gltf = await loader.loadAsync(url);
  return { scene: gltf.scene, animations: gltf.animations };
}

/** `SkeletonUtils`, imported once and only when a body is actually cloned. */
let skeletonUtils: Promise<{ clone(source: Object3D): Object3D }> | null = null;

/**
 * three's `SkeletonUtils`, lazily.
 *
 * It is a `three/addons` module that imports bare `three`, so keeping it out of
 * the eager graph is worth the one `await` per spawn.
 *
 * @returns The module, or the in-flight import of it.
 */
export function loadSkeletonUtils(): Promise<{ clone(source: Object3D): Object3D }> {
  skeletonUtils ??= import('three/addons/utils/SkeletonUtils.js').then(
    (module) => module as unknown as { clone(source: Object3D): Object3D },
  );
  return skeletonUtils;
}

/**
 * The yaw a rotation carries about `+Y`, in radians.
 *
 * Read by rotating the forward axis rather than decomposing to Euler angles, so
 * it is right for any rotation rather than only for one built from a yaw.
 *
 * @param q The rotation.
 *
 * @returns Yaw in radians.
 */
export function yawOf(q: Quaternion): number {
  // q * (0, 0, 1)
  const fx = 2 * (q.x * q.z + q.y * q.w);
  const fz = 1 - 2 * (q.x * q.x + q.y * q.y);
  return Math.atan2(fx, fz);
}

/**
 * Copy an ARKit-52 vector straight through, for a bundle that already speaks it
 * in a longer vector.
 *
 * @param arkit The ARKit-52 vector.
 * @param out The bundle-space vector.
 *
 * @returns Nothing.
 */
export function passThrough(arkit: Float32Array, out: Float32Array): void {
  out.fill(0);
  out.set(arkit.subarray(0, Math.min(arkit.length, out.length)));
}

/**
 * Resolve a path that sits beside a manifest entry.
 *
 * An absolute path or URL is taken as it is; anything else is read relative to
 * the entry's own directory, which is what "the bundle directory contains the
 * pack" means on disk.
 *
 * @param entryUrl The entry's resolved URL.
 * @param path The sibling path from the manifest.
 *
 * @returns A URL the browser can fetch.
 */
export function resolveSibling(entryUrl: string, path: string): string {
  if (path.startsWith('/') || /^[a-z][a-z0-9+.-]*:/i.test(path)) return path;
  const directory = entryUrl.slice(0, entryUrl.lastIndexOf('/') + 1);
  return `${directory}${path}`;
}

/**
 * The file name at the end of a URL, without its query or fragment.
 *
 * `GnmRigBackend` looks its pack up by bundle-relative file name, so the name
 * handed to the constructor and the name `getBytes` answers to must agree.
 *
 * @param url The URL.
 *
 * @returns The last path segment.
 */
export function fileNameOf(url: string): string {
  const clean = url.split('#')[0].split('?')[0];
  return clean.slice(clean.lastIndexOf('/') + 1);
}
