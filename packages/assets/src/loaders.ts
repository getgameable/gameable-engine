/**
 * The two loaders core registers by default: `gltf` and `audio`.
 *
 * `splat` and `character` are registered later by their own packages through
 * {@link AssetRegistry.registerLoader}, so this package never imports them.
 *
 * three's addon loaders are pulled in with dynamic `import()` on first use. That
 * keeps `gameable/assets` importable — and unit-testable — in Node without
 * dragging the renderer into the module graph.
 */
import type { GLTF } from 'three/addons/loaders/GLTFLoader.js';
import type { WebGPURenderer } from 'three/webgpu';

import type { AssetLoader } from './registry.js';

/** Where `DRACOLoader` looks for its decoder, when none is configured. */
export const DEFAULT_DRACO_DECODER_PATH = '/draco/';

/** Options accepted by {@link createGltfLoader}. */
export interface GltfLoaderOptions {
  /**
   * Directory holding `draco_decoder.js` / `.wasm`, served by your app.
   *
   * Defaults to {@link DEFAULT_DRACO_DECODER_PATH}. Copy the files from
   * `three/examples/jsm/libs/draco/` into your `public/` directory, or point
   * this at a CDN.
   */
  readonly dracoDecoderPath?: string;
  /**
   * Directory holding the Basis Universal transcoder. When omitted, KTX2
   * textures are not supported and no `KTX2Loader` is constructed.
   */
  readonly ktx2TranscoderPath?: string;
  /**
   * An initialised renderer. Required for KTX2: `detectSupport` needs to know
   * which compressed texture formats the backend exposes.
   */
  readonly renderer?: WebGPURenderer;
}

/** A `gltf` loader plus the handles needed to release its workers. */
export interface GltfLoaderHandle {
  /** Register this under the `gltf` asset type. */
  readonly load: AssetLoader;
  /**
   * Terminate the Draco and KTX2 worker pools.
   *
   * @returns Nothing.
   */
  dispose(): void;
}

/**
 * Build the `gltf` asset loader.
 *
 * The underlying `GLTFLoader`, `DRACOLoader` and optional `KTX2Loader` are
 * constructed lazily, on the first asset that needs them.
 *
 * @param options Draco decoder path, optional KTX2 transcoder path and renderer.
 * @returns The loader function and its `dispose`.
 *
 * @example
 * ```ts
 * import { createAssetRegistry, createGltfLoader, parseManifest } from 'gameable/assets';
 *
 * const gltf = createGltfLoader({ dracoDecoderPath: '/draco/' });
 * const manifest = parseManifest({ version: 1, assets: [{ id: 'rock', type: 'gltf', src: 'rock.glb' }] });
 * const assets = createAssetRegistry({ manifest, loaders: { gltf: gltf.load } });
 * console.log(assets.hasLoader('gltf')); // true
 * ```
 */
export function createGltfLoader(options: GltfLoaderOptions = {}): GltfLoaderHandle {
  let loaderPromise: Promise<(url: string) => Promise<GLTF>> | undefined;
  const disposers: (() => void)[] = [];

  /**
   * Construct the three loaders once and memoise the result.
   *
   * @returns A function that loads one URL into a `GLTF`.
   */
  async function ensure(): Promise<(url: string) => Promise<GLTF>> {
    const [{ GLTFLoader }, { DRACOLoader }] = await Promise.all([
      import('three/addons/loaders/GLTFLoader.js'),
      import('three/addons/loaders/DRACOLoader.js'),
    ]);

    const draco = new DRACOLoader();
    draco.setDecoderPath(options.dracoDecoderPath ?? DEFAULT_DRACO_DECODER_PATH);
    disposers.push(() => {
      draco.dispose();
    });

    const loader = new GLTFLoader();
    loader.setDRACOLoader(draco);

    if (options.ktx2TranscoderPath !== undefined && options.renderer !== undefined) {
      const { KTX2Loader } = await import('three/addons/loaders/KTX2Loader.js');
      const ktx2 = new KTX2Loader();
      ktx2.setTranscoderPath(options.ktx2TranscoderPath);
      ktx2.detectSupport(options.renderer);
      loader.setKTX2Loader(ktx2);
      disposers.push(() => {
        ktx2.dispose();
      });
    }

    return (url) => loader.loadAsync(url);
  }

  return {
    load: async (url) => {
      loaderPromise ??= ensure();
      const load = await loaderPromise;
      return load(url);
    },
    dispose() {
      for (const d of disposers.splice(0)) d();
      loaderPromise = undefined;
    },
  };
}

/** Options accepted by {@link createAudioLoader}. */
export interface AudioLoaderOptions {
  /** `fetch` implementation. Defaults to the global one. */
  readonly fetch?: typeof globalThis.fetch;
}

/**
 * Build the `audio` asset loader.
 *
 * It resolves to the raw `ArrayBuffer`. Turning that into an `AudioBuffer` is
 * `gameable/audio`'s job, because decoding needs an `AudioContext` and the
 * registry must stay usable without one.
 *
 * @param options `fetch` override.
 * @returns An asset loader resolving to an `ArrayBuffer`.
 *
 * @example
 * ```ts
 * import { createAssetRegistry, createAudioLoader, parseManifest } from 'gameable/assets';
 *
 * const manifest = parseManifest({ version: 1, assets: [{ id: 'shot', type: 'audio', src: 'shot.ogg' }] });
 * const assets = createAssetRegistry({ manifest, loaders: { audio: createAudioLoader() } });
 * const bytes = (await assets.load('shot')) as ArrayBuffer;
 * console.log(bytes.byteLength > 0);
 * ```
 */
export function createAudioLoader(options: AudioLoaderOptions = {}): AssetLoader {
  return async (url, entry, ctx) => {
    const doFetch = options.fetch ?? globalThis.fetch;
    const response = await doFetch(url, ctx.signal ? { signal: ctx.signal } : undefined);
    if (!response.ok) {
      throw new Error(`audio "${entry.id}": ${url} responded ${String(response.status)}`);
    }
    return response.arrayBuffer();
  };
}

/** Options accepted by {@link createDefaultLoaders}. */
export interface DefaultLoaderOptions extends GltfLoaderOptions, AudioLoaderOptions {}

/** The default loader set plus the handle needed to release three's workers. */
export interface DefaultLoaders {
  /** Pass straight to `createAssetRegistry({ loaders })`. */
  readonly loaders: Record<string, AssetLoader>;
  /**
   * Terminate any worker pools the loaders started.
   *
   * @returns Nothing.
   */
  dispose(): void;
}

/**
 * The loaders `createEngine` registers: `gltf` and `audio`.
 *
 * @param options Draco/KTX2 paths and a `fetch` override.
 * @returns The loader map and its `dispose`.
 *
 * @example
 * ```ts
 * import { createAssetRegistry, createDefaultLoaders, parseManifest } from 'gameable/assets';
 *
 * const defaults = createDefaultLoaders({ dracoDecoderPath: '/draco/' });
 * const manifest = parseManifest({ version: 1, assets: [] });
 * const assets = createAssetRegistry({ manifest, loaders: defaults.loaders });
 * console.log(assets.hasLoader('audio')); // true
 * ```
 */
export function createDefaultLoaders(options: DefaultLoaderOptions = {}): DefaultLoaders {
  const gltf = createGltfLoader(options);
  return {
    loaders: { gltf: gltf.load, audio: createAudioLoader(options) },
    dispose() {
      gltf.dispose();
    },
  };
}
