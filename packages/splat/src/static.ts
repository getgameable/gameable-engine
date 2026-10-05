/**
 * The static path: a splat file on disk becomes a `GaussianSplat` in the scene.
 *
 * Four container formats, all decoded by three's own addon loaders into the same
 * `BufferGeometry`, plus the glTF `KHR_gaussian_splatting` extension. The default uses upstream rendering; optional
 * relighting selects the maintained fork with the same loading and sort lifecycle.
 */
import type { BufferGeometry, Sphere } from 'three/webgpu';
import { GaussianSplat } from 'three/addons/objects/GaussianSplat.js';
import { GaussianSplatPLYLoader } from 'three/addons/loaders/GaussianSplatPLYLoader.js';
import { GLTFGaussianSplatLoaderExtension } from 'three/addons/loaders/GLTFGaussianSplatLoaderExtension.js';
import { KSPLATLoader } from 'three/addons/loaders/KSPLATLoader.js';
import { SPLATLoader } from 'three/addons/loaders/SPLATLoader.js';
import { SPZLoader } from 'three/addons/loaders/SPZLoader.js';
import { getSphericalHarmonicsDegree } from 'three/addons/utils/GaussianSplatUtils.js';

import {
  AnimatedGaussianSplat,
  type SplatEnvironmentLighting,
} from './three-fork/AnimatedGaussianSplat.js';

import { initCountingSortPatch } from './sortPatch.js';

import { SPLAT_RENDER_ORDER } from './AnimatedSplat.js';

/** Container formats {@link loadSplat} understands. */
export type SplatFormat = 'spz' | 'ply' | 'splat' | 'ksplat';

/** `SplatFormat`, or `'auto'` to sniff. */
export type SplatFormatOption = SplatFormat | 'auto';

/** A decoded splat file. */
export interface SplatAsset {
  /** Geometry with `position` (f32x3), `covariance` (f32x6), `color` (u8x4) and optional SH. */
  readonly geometry: BufferGeometry;
  /** Gaussians in the file. */
  readonly count: number;
  /** Spherical-harmonics degree, 0 to 3. Degree 0 is flat colour. */
  readonly shDegree: number;
  /** Bounds of the centres, in the file's own coordinate system. */
  readonly boundingSphere: Sphere;
  /** Which decoder ran. */
  readonly format: SplatFormat;
  /** Where it came from. */
  readonly url: string;
}

/** Options accepted by {@link loadSplat}. */
export interface LoadSplatOptions {
  /** Force a decoder instead of sniffing. Defaults to `'auto'`. */
  readonly format?: SplatFormatOption;
  /** Aborts the fetch. The decode itself is synchronous and is not interruptible. */
  readonly signal?: AbortSignal;
  /** Replaces `globalThis.fetch`, for tests and for an asset-manager transport. */
  readonly fetch?: typeof globalThis.fetch;
}

/** Options accepted by {@link createSplatObject}. */
export interface CreateSplatObjectOptions {
  /** Opt into diffuse lighting; omitted keeps the native, unlit splat path. */
  readonly environmentLighting?: SplatEnvironmentLighting;
  /**
   * Re-sort in `onBeforeRender` when the camera turns far enough. Defaults to `true`. Turn it
   * off only if you drive `updateSort` yourself.
   */
  readonly autoSort?: boolean;
  /** Draw order. Defaults to {@link SPLAT_RENDER_ORDER}. */
  readonly renderOrder?: number;
  /**
   * What the file's colour bytes mean. `'srgb'` (the default) is what nearly every splat holds:
   * trained against photographs read as they are stored, blending sRGB values. It draws through
   * the fork (`AnimatedGaussianSplat`) in the sRGB pass (`gameable/core`'s `attachSrgbPass`,
   * which the engine attaches; without one it draws nothing and warns once). `'linear'` is for a
   * splat trained in linear light: three's own `GaussianSplat`, in the app's pass. The choice
   * marks the asset's geometry (`userData.colorSpace`), so every object made from it agrees.
   */
  readonly colorSpace?: 'linear' | 'srgb';
  /**
   * Make it the maintained fork, which can receive shadows (`setShadowReceiver`); it draws
   * exactly as three's own until one is switched on. Defaults to false here; the splat
   * service's `add` passes true.
   */
  readonly receiveShadows?: boolean;
}

/** A splat file that could not be decoded. */
export class SplatLoadError extends Error {
  /** The URL that failed. */
  readonly url: string;

  /**
   * Build a splat load error.
   *
   * @param url The URL that failed.
   * @param message What went wrong.
   * @param options Standard `Error` options, used to keep the cause.
   */
  constructor(url: string, message: string, options?: ErrorOptions) {
    super(`@gameable/splat: ${message} (${url})`, options);
    this.name = 'SplatLoadError';
    this.url = url;
  }
}

/** `.spz` v4 magic, `"NGSP"` read as a little-endian u32. */
const SPZ_MAGIC = 0x5053474e;

/** Bytes per row in the fixed-width `.splat` format. */
const SPLAT_ROW_BYTES = 32;

/** Extension to format, for the cheap half of the sniff. */
const BY_EXTENSION: Readonly<Record<string, SplatFormat>> = {
  spz: 'spz',
  ply: 'ply',
  splat: 'splat',
  ksplat: 'ksplat',
};

/**
 * Guess the container format from the URL and the first bytes.
 *
 * The extension wins when it is one we know, because `.ksplat` has no magic number and
 * `.splat` has no header at all. Content sniffing is the fallback, and it can only recognise
 * the two formats that are self-describing: SPZ (gzip, or `NGSP` for v4) and PLY (`ply\n`).
 *
 * @param url The URL the bytes came from. Query and hash are ignored.
 * @param bytes At least the first 8 bytes of the file.
 * @returns The format.
 * @throws {SplatLoadError} When neither the extension nor the content identifies it.
 *
 * @example
 * ```ts
 * import { sniffSplatFormat } from 'gameable/splat';
 *
 * sniffSplatFormat('/models/arena.spz', new Uint8Array(8)); // 'spz'
 * ```
 */
export function sniffSplatFormat(url: string, bytes: Uint8Array): SplatFormat {
  const path = url.split(/[?#]/, 1)[0] ?? url;
  const extension = /\.([a-z0-9]+)$/i.exec(path)?.[1]?.toLowerCase();
  const byExtension = extension === undefined ? undefined : BY_EXTENSION[extension];
  if (byExtension !== undefined) return byExtension;

  if (bytes.length >= 4) {
    // gzip: every SPZ before v4 is a gzip stream.
    if (bytes[0] === 0x1f && bytes[1] === 0x8b) return 'spz';
    // SPZ v4 is zstd inside an uncompressed header whose first word is the magic.
    const magic = bytes[0] | (bytes[1] << 8) | (bytes[2] << 16) | (bytes[3] << 24);
    if (magic >>> 0 === SPZ_MAGIC) return 'spz';
    // PLY is ASCII-headed: "ply" then CR or LF.
    if (
      bytes[0] === 0x70 &&
      bytes[1] === 0x6c &&
      bytes[2] === 0x79 &&
      (bytes[3] === 0x0a || bytes[3] === 0x0d)
    ) {
      return 'ply';
    }
  }

  throw new SplatLoadError(
    url,
    `cannot tell what format this is. The extension ${
      extension === undefined
        ? 'is missing'
        : `".${extension}" is not one of spz, ply, splat, ksplat`
    } and the first bytes match neither gzip/SPZ nor PLY. Pass { format: 'splat' | 'ksplat' | … }`,
  );
}

/**
 * Decode a buffer that has already been fetched.
 *
 * Separated from {@link loadSplat} so tests can drive every decoder from memory, and so an
 * asset pipeline that already holds the bytes does not fetch twice.
 *
 * @param buffer The file.
 * @param url Where it came from, for sniffing and error messages.
 * @param format Decoder to use, or `'auto'`.
 * @returns The decoded asset.
 *
 * @example
 * ```ts
 * import { parseSplat } from 'gameable/splat';
 *
 * const asset = await parseSplat(bytes, 'arena.spz');
 * console.log(asset.count, asset.shDegree);
 * ```
 */
export async function parseSplat(
  buffer: ArrayBuffer,
  url: string,
  format: SplatFormatOption = 'auto',
): Promise<SplatAsset> {
  const head = new Uint8Array(buffer, 0, Math.min(16, buffer.byteLength));
  const resolved = format === 'auto' ? sniffSplatFormat(url, head) : format;

  if (resolved === 'splat' && buffer.byteLength % SPLAT_ROW_BYTES !== 0) {
    throw new SplatLoadError(
      url,
      `a .splat file is a whole number of ${String(SPLAT_ROW_BYTES)}-byte rows, but this is ` +
        `${String(buffer.byteLength)} bytes`,
    );
  }

  let geometry: BufferGeometry | undefined;
  try {
    switch (resolved) {
      case 'spz':
        // SPZ v4 is zstd and decodes asynchronously; v1-3 returns synchronously.
        geometry = await new SPZLoader().parse(buffer);
        break;
      case 'ply':
        geometry = new GaussianSplatPLYLoader().parse(buffer);
        break;
      case 'splat':
        geometry = new SPLATLoader().parse(buffer);
        break;
      case 'ksplat':
        geometry = new KSPLATLoader().parse(buffer);
        break;
    }
  } catch (cause) {
    throw new SplatLoadError(url, `the ${resolved} decoder rejected this file`, { cause });
  }

  // `getAttribute` is typed as total but is not: a decoder that produced nothing returns
  // undefined here, and the count below would then be the real failure site.
  const position = geometry?.getAttribute('position') as { count: number } | undefined;
  if (geometry === undefined || position === undefined) {
    throw new SplatLoadError(url, `the ${resolved} decoder produced no splats`);
  }

  if (geometry.boundingSphere === null) geometry.computeBoundingSphere();
  const boundingSphere = geometry.boundingSphere;
  if (boundingSphere === null) {
    throw new SplatLoadError(url, 'the decoded geometry has no computable bounding sphere');
  }

  return {
    geometry,
    count: position.count,
    shDegree: getSphericalHarmonicsDegree(geometry),
    boundingSphere,
    format: resolved,
    url,
  };
}

/**
 * Fetch and decode a splat file.
 *
 * @param url SPZ, PLY, SPLAT or KSPLAT.
 * @param options Format override, abort signal, custom `fetch`.
 * @returns The decoded asset.
 * @throws {SplatLoadError} On a non-2xx response, an unrecognised format or a decoder failure.
 *
 * @example
 * ```ts
 * import { createSplatObject, loadSplat } from 'gameable/splat';
 *
 * const asset = await loadSplat('/models/arena.spz');
 * attachSrgbPass(renderer, scene); // from gameable/core: sRGB splats draw in its pass
 * scene.add(createSplatObject(asset));
 * ```
 */
export async function loadSplat(url: string, options: LoadSplatOptions = {}): Promise<SplatAsset> {
  const doFetch = options.fetch ?? globalThis.fetch;
  const response = await doFetch(url, { signal: options.signal });
  if (!response.ok) {
    throw new SplatLoadError(
      url,
      `fetch failed: ${String(response.status)} ${response.statusText}`,
    );
  }
  const buffer = await response.arrayBuffer();
  return parseSplat(buffer, url, options.format ?? 'auto');
}

/**
 * Turn a decoded asset into a scene object.
 *
 * Uses three's own `GaussianSplat` unless lighting or shadows are asked for; then the maintained
 * fork, which on a real geometry takes upstream's own path (the same one-time repack) and only
 * adds the switches.
 *
 * @param asset A decoded asset.
 * @param options Sort behaviour and draw order.
 * @returns The object, with its bounds computed and its render order set.
 *
 * @example
 * ```ts
 * attachSrgbPass(renderer, scene); // from gameable/core: sRGB splats draw in its pass
 * const splat = createSplatObject(asset, { autoSort: true });
 * splat.position.y = -1;
 * scene.add(splat);
 * ```
 */
export function createSplatObject(
  asset: SplatAsset,
  options: CreateSplatObjectOptions = {},
): GaussianSplat | AnimatedGaussianSplat {
  initCountingSortPatch();
  const colorSpace =
    options.colorSpace ??
    (asset.geometry.userData.colorSpace as 'linear' | 'srgb' | undefined) ??
    'srgb';
  asset.geometry.userData.colorSpace = colorSpace;
  const splat =
    options.environmentLighting === undefined &&
    colorSpace === 'linear' &&
    options.receiveShadows !== true
      ? new GaussianSplat(asset.geometry, { autoSort: options.autoSort ?? true })
      : new AnimatedGaussianSplat(asset.geometry, { autoSort: options.autoSort ?? true });
  if (splat instanceof AnimatedGaussianSplat && options.environmentLighting !== undefined)
    splat.setEnvironmentLighting(options.environmentLighting);
  splat.name = `splat:${asset.format}`;
  // Splats draw after opaque geometry, and after ordinary transparent meshes: a splat cloud
  // has no single depth to sort by, so it must not be interleaved by its object centre.
  splat.renderOrder = options.renderOrder ?? SPLAT_RENDER_ORDER;
  // Expands each splat by its own extent, unlike the geometry's centre-only sphere, and the
  // sort's depth range is built from it.
  splat.computeBoundingSphere();
  return splat;
}

/** The subset of `GLTFLoader` this package needs, so the loader itself is not imported. */
export interface GltfLoaderLike {
  /**
   * three's plugin hook.
   *
   * @param callback Builds the plugin from the parser.
   * @returns The loader, for chaining.
   */
  register(callback: (parser: never) => unknown): unknown;
}

/**
 * Teach a `GLTFLoader` to read `KHR_gaussian_splatting`.
 *
 * Register it before the first `load`; meshes carrying the extension then come back as
 * `GaussianSplat` nodes inside the glTF scene graph. Their render order is **not** set for
 * you, because the glTF author owns that graph — walk the result and set
 * {@link SPLAT_RENDER_ORDER} if splats are interleaving with your transparent meshes.
 *
 * @param gltfLoader The loader to extend.
 * @returns Nothing.
 *
 * @example
 * ```ts
 * import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
 * import { registerGltfSplatExtension } from 'gameable/splat';
 *
 * const loader = new GLTFLoader();
 * registerGltfSplatExtension(loader);
 * const gltf = await loader.loadAsync('/models/scene.glb');
 * ```
 */
export function registerGltfSplatExtension(gltfLoader: GltfLoaderLike): void {
  gltfLoader.register((parser) => new GLTFGaussianSplatLoaderExtension(parser));
}

export { GaussianSplat, SPLAT_RENDER_ORDER };
