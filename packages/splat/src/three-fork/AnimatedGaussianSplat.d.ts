/**
 * Types for the fork in `AnimatedGaussianSplat.js`.
 *
 * Hand-written, because the fork is verbatim upstream JavaScript plus marked insertions and
 * must not gain a single character of TypeScript. The shape below is `@types/three`'s
 * `GaussianSplat` declaration plus the fork's additions; it deliberately does not `extends`
 * that declaration, because dynamic mode widens `splatGeometry` to `BufferGeometry | null`,
 * which is not a legal property override.
 */
import type {
  Box3,
  BufferAttribute,
  BufferGeometry,
  Camera,
  DepthTexture,
  InstancedBufferGeometry,
  Matrix4,
  Mesh,
  Node,
  NodeMaterial,
  PointLight,
  Renderer,
  Sphere,
  Vector3,
  Vector4,
} from 'three/webgpu';

/** Optional diffuse environment and point lighting mixed with captured Gaussian radiance. */
export interface SplatEnvironmentLighting {
  /** Nine RGB radiance SH coefficients, in three's SphericalHarmonics3 world-space order. */
  radianceSH: readonly (readonly [number, number, number])[];
  /** Captured-color contribution, default 0.25. Use 1 with diffuseWeight 0 to preserve it. */
  emissionWeight?: number;
  /** Lambert diffuse contribution, default 0.75. */
  diffuseWeight?: number;
  /** Local-space interior point for outward normal orientation; defaults to bound centre. */
  normalOrigin?: readonly [number, number, number];
  /** Interpretation of source colors; default linear preserves the existing splat pipeline. */
  inputColorSpace?: 'linear' | 'srgb';
  /** Up to sixteen host PointLights; transforms, colors, intensity, range, decay and visibility update through uniforms every render. No shadows. */
  pointLights?: readonly PointLight[];
  /** Illuminate both sides of approximate covariance normals, useful for room interiors. Default false. */
  twoSided?: boolean;
  /** Positive light-source radius in world units to bound near-field attenuation; default 0.25. */
  pointLightSoftness?: number;
}

/** Numbers a shadow receiver reads every render (fork edit 16). Mutate them; nothing rebuilds. */
export interface SplatShadowParams {
  /** How dark full shadow is, 0 to 1. */
  strength: number;
  /** Depth bias in the map's 0..1 depth units. */
  bias: number;
  /**
   * How many of `tiles` are live: 1 (the default) covers the whole map with the first; 2 to 4 lay
   * them out as a 2 x 2 atlas.
   */
  tileCount?: number;
  /** How dark the contact shadow under a foot is, 0 to 1. */
  contactStrength?: number;
  /** How many of `contacts` are live this frame. */
  contactCount?: number;
  /** Contact shadow radius in metres. Defaults to 0.18. */
  contactRadius?: number;
}

/** A key light's shadow as a splat (or a mesh) receives it (fork edit 16). */
export interface SplatShadowReceiverOptions {
  /** The key light's depth map, or null for the contact shadow alone. */
  map: DepthTexture | null;
  /** World to the light's clip space, depth 0..1; the owner keeps it current. */
  matrix?: Matrix4;
  /**
   * Instead of `matrix`: one to four light cameras sharing the map as an atlas, each world to its
   * own clip space; `params.tileCount` says how many are live. A point reads the first live tile
   * that holds it. The owner keeps them current.
   */
  tiles?: Matrix4[];
  /** The map's size in texels. */
  size?: number;
  /** The filter: flat `[dx, dy, weight, ...]` in texels, weights summing to 1. */
  taps?: readonly number[];
  /** Read every render. */
  params: SplatShadowParams;
  /** One to sixteen floor points under the feet (xyz, weight in w), read every render. */
  contacts?: Vector4[] | null;
}

/** The uniforms of one receiver, for {@link shadowFactorAt}. Opaque. */
export interface SplatShadowReceiver {
  readonly map: DepthTexture | null;
}

/**
 * Check a receiver's options and build its uniforms (shared by `setShadowReceiver` and meshes).
 *
 * @param options The receiver.
 * @returns The uniforms.
 */
export function createShadowReceiver(options: SplatShadowReceiverOptions): SplatShadowReceiver;

/**
 * The factor a colour keeps at a world point under the receiver's shadows (a float node).
 *
 * @param worldPosition A vec3 node in world space.
 * @param receiver From {@link createShadowReceiver}.
 * @returns A float node, 1 where fully lit.
 */
export function shadowFactorAt(worldPosition: Node, receiver: SplatShadowReceiver): Node<'float'>;

/** Options accepted by the constructor, unchanged from upstream. */
export interface AnimatedGaussianSplatOptions {
  /** Sort in `onBeforeRender`. Defaults to `true`. */
  autoSort?: boolean | undefined;
}

/**
 * The dynamic constructor path: capacity instead of geometry.
 *
 * Handing this to the constructor allocates `capacity` gaussians of zero-filled GPU storage
 * with no CPU mirror and no O(N) repack.
 */
export interface AnimatedGaussianSplatDescriptor {
  /** How many gaussians to allocate. Fixed for the object's lifetime. */
  capacity: number;
  /**
   * Where the gaussians will be, in local space.
   *
   * Not cosmetic: the sort's depth range is derived from it. Defaults to the unit sphere at
   * the origin, which is almost never what you want. See `setBoundingSphere`.
   */
  boundingSphere?: Sphere | undefined;
  /**
   * What the packed colour bytes mean. `'linear'` (the default, upstream's assumption) is
   * encoded to sRGB once more by the renderer's output pass; `'srgb'` is decoded per gaussian in
   * the vertex shader first, so a cloud whose colours are already sRGB (a Gameable studio character,
   * trained against photographs) draws with the colours its file holds.
   */
  colorSpace?: 'linear' | 'srgb' | undefined;
  /**
   * The kernel it draws with: three's (`'three'`, the default) or the Gameable studio's
   * (`'studio'`: 2.83 sigma, tail subtracted, trained opacity), which exported characters were
   * made on. Edit 18.
   */
  kernel?: 'three' | 'studio' | undefined;
}

/**
 * Something the splat cannot do on the backend it was given.
 *
 * Today: asking dynamic mode for spherical-harmonics degree above 0, and `setSortCenters` on a
 * static splat.
 */
export declare class SplatUnsupportedError extends Error {
  constructor(message: string);
  name: string;
}

/**
 * three r186's `GaussianSplat` with a dynamic-capacity constructor, a forced re-sort and
 * owner-supplied bounds.
 */
export declare class AnimatedGaussianSplat extends Mesh<InstancedBufferGeometry, NodeMaterial> {
  constructor(
    source: AnimatedGaussianSplatDescriptor | BufferGeometry,
    options?: AnimatedGaussianSplatOptions,
  );

  readonly isGaussianSplat: true;

  /** The source geometry, or `null` in dynamic mode, which keeps no CPU mirror. */
  splatGeometry: BufferGeometry | null;
  boundingBox: Box3 | null;
  boundingSphere: Sphere | null;
  autoSort: boolean;
  /** What the colour buffer's bytes mean; fixed at construction (see the descriptor). */
  readonly colorSpace: 'linear' | 'srgb';
  /**
   * For an sRGB cloud (`colorSpace: 'srgb'`), 1 while an sRGB pass draws it: the colour is encoded
   * back to sRGB per gaussian, after tint, light and shadow, so it blends on sRGB values as it was
   * trained. At 0 the cloud draws nothing (and warns once). Null for a linear cloud.
   */
  readonly srgbOutput: { value: number } | null;

  /**
   * Mix captured radiance with diffuse environment lighting. Pass null to restore the original shader.
   * Derives approximate normals from current covariance; needs no CPU mirror or new GPU buffers.
   * Call when the probe or light list changes, not per frame. Probe data is copied; lights stay live.
   * Point lights use softened distance attenuation and approximate Lambert normals, without shadows.
   *
   * @example
   * ```ts
   * import { PointLight } from 'three/webgpu';
   * import { AnimatedGaussianSplat } from 'gameable/splat';
   * const splat = new AnimatedGaussianSplat({ capacity: 1000 });
   * splat.setEnvironmentLighting({
   *   radianceSH: [[3.5449, 3.5449, 3.5449], ...Array.from({ length: 8 }, () => [0, 0, 0] as const)],
   *   emissionWeight: 0.2, diffuseWeight: 0.8,
   * });
   * // Optional live point lighting, including static splat geometry on WebGL:
   * const lamp = new PointLight(0xffbd78, 2.6, 3.4);
   * splat.setEnvironmentLighting({
   *   radianceSH: Array.from({ length: 9 }, () => [0, 0, 0] as const),
   *   pointLights: [lamp], twoSided: true, emissionWeight: 0.3,
   * });
   * lamp.intensity = 3; // uniform update, no shader rebuild
   * splat.setEnvironmentLighting(null);
   * ```
   */
  setEnvironmentLighting(options: SplatEnvironmentLighting | null): void;
  /**
   * Scale each fragment's opacity by a node built from the splat's view-space centre, or
   * null to draw as upstream.
   *
   * @example
   * ```ts
   * splat.setFragmentAlpha((view) => float(1));
   * splat.setFragmentAlpha(null);
   * ```
   */
  setFragmentAlpha(builder: ((view: Node) => Node) | null): void;

  /**
   * Multiply every gaussian's colour (linear, after the colour-space decode): a tint and an
   * exposure. `(1, 1, 1)`, the default, draws the colours as they are. Edit 19.
   *
   * @example
   * ```ts
   * splat.setColorScale(1.1, 1.0, 0.85); // warmer
   * ```
   */
  setColorScale(r: number, g: number, b: number): void;
  /**
   * Darken each gaussian a key light's depth map says is blocked and each one on the floor under
   * a foot (fork edit 16), or null to draw as before. Rebuilds the material; call it when the
   * shadow's setup changes (a quality level), never per frame: the numbers in `params`, the
   * matrix and the contact points are read every render.
   *
   * @example
   * ```ts
   * import { DepthTexture, Matrix4 } from 'three/webgpu';
   * import { AnimatedGaussianSplat } from 'gameable/splat';
   * const splat = new AnimatedGaussianSplat({ capacity: 1000 });
   * const params = { strength: 0.5, bias: 0.001 };
   * splat.setShadowReceiver({
   *   map: new DepthTexture(1024, 1024), matrix: new Matrix4(), size: 1024,
   *   taps: [0, 0, 1], params,
   * });
   * splat.setShadowReceiver(null);
   * ```
   */
  setShadowReceiver(options: SplatShadowReceiverOptions | null): void;

  updateSphericalHarmonics(renderer: Renderer, camera: Camera): boolean;

  /** No-op in dynamic mode. */
  computeBoundingBox(): void;

  /** In dynamic mode, guarantees a non-null sphere and otherwise leaves the owner's alone. */
  computeBoundingSphere(): void;

  /**
   * Sorts when the camera turned or the gaussians changed. On the WebGL fallback a dynamic
   * splat sorts on the CPU from the centres last passed to `setSortCenters`, and returns false
   * (index order) until the first call.
   */
  updateSort(renderer: Renderer, camera: Camera): boolean;

  /**
   * Hands the WebGL fallback's CPU sort the centres to sort by, `capacity * 3` floats of local
   * xyz (the padded capacity, see `padStorageCapacity`). Kept by reference. Dynamic mode only.
   *
   * @throws {SplatUnsupportedError} on a static splat.
   */
  setSortCenters(centers: Float32Array): void;

  /** Forces the next `updateSort` to dispatch, whatever the camera did. */
  markGaussiansChanged(): void;

  /** Declares where the gaussians are, in local space. */
  setBoundingSphere(center: Vector3, radius: number): void;

  /**
   * Releases the geometry, the material and every storage buffer this splat owns — the four in
   * `_buffers`, the lazily created spherical-harmonics contribution buffer, and the four the
   * `CountingSort` holds. Idempotent.
   *
   * Disposing a `BufferAttribute` only dispatches its `dispose` event, which nothing in three
   * listens for on a storage attribute, so `release` is what actually frees the `GPUBuffer`.
   * Pass `releaseStorageAttribute` bound to the renderer (`src/backendBuffers.ts`).
   */
  dispose(release?: ((attribute: BufferAttribute) => void) | null): void;

  /** Every `StorageBufferAttribute` this splat owns, deduplicated. */
  storageAttributes(): Set<BufferAttribute>;
}

/**
 * The storage capacity a dynamic splat allocates for a requested one: the `width * height` of
 * the WebGL fallback's PBO texture, `width = 2^ceil(log2(sqrt(capacity)))`. Padded slots stay
 * zero and invisible.
 *
 * @param capacity Requested gaussians, a positive integer.
 * @returns The padded capacity, at least capacity.
 */
export declare function padStorageCapacity(capacity: number): number;
