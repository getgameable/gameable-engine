/**
 * The `splat` engine module.
 *
 * It does one thing: teach the asset registry what a `splat` entry is. Core cannot know —
 * `gameable/assets` deliberately ships only the `gltf` and `audio` loaders so that it stays
 * importable in Node — so the type arrives with the package that implements it.
 *
 * The module registers no update hook, but the splats it puts in the scene are not free per
 * frame: three drives each one from its own `onBeforeRender`. A static splat re-runs the GPU
 * counting sort whenever the view direction turns past `SORT_DIRECTION_THRESHOLD` (0.9995,
 * about 1.81 degrees) and skips the dispatch otherwise; a dynamic one re-sorts on *every* frame
 * in which its producer (`gameable/character`) called `markGaussiansChanged`, which is every
 * frame the avatar animates. One sort is one compute pass of four dispatches, because
 * `init` applies `initCountingSortPatch()`; unpatched, three would submit four.
 */
import { requireRenderContext, type EngineModule, type HostContext } from '@gameable/core';

import { initCountingSortPatch } from './sortPatch.js';
import {
  createSplatObject,
  loadSplat,
  type SplatAsset,
  type CreateSplatObjectOptions,
} from './static.js';

/** Options accepted by {@link splat}. */
export interface SplatModuleOptions {
  /**
   * Force a decoder for every `splat` asset instead of sniffing each one. Leave unset unless
   * your assets are served from URLs with no useful extension.
   */
  readonly format?: SplatAsset['format'];
}

/** What `engine.get('splat')` returns. */
export interface SplatService {
  /**
   * Every splat asset loaded through the registry, by asset id.
   *
   * Assets are cached by the registry, so this is a view of it, not a second cache.
   */
  readonly loaded: ReadonlyMap<string, SplatAsset>;

  /**
   * Every object `add` has put in the scene, in order (an object removed from the scene stays
   * listed; its `parent` is null). The character bridge reads it to find the places that
   * receive shadows.
   */
  readonly added: readonly ReturnType<typeof createSplatObject>[];

  /**
   * Add a loaded asset to the scene as a `GaussianSplat`, with the right draw order.
   *
   * It receives shadows unless `receiveShadows: false` is passed: the object is then the
   * maintained fork (`AnimatedGaussianSplat`), which draws exactly as three's own until a
   * shadow is switched on.
   *
   * @param id Asset id, as declared in `assets.json`.
   * @returns The object that was added.
   */
  add(id: string, options?: CreateSplatObjectOptions): ReturnType<typeof createSplatObject>;
}

declare module '@gameable/core' {
  interface EngineServices {
    /** Splat loading and scene insertion. */
    splat: SplatService;
  }
}

/**
 * The splat `EngineModule`.
 *
 * Registers the `splat` asset type, so `{ "id": "arena", "type": "splat", "src": "arena.spz" }`
 * in `assets.json` resolves to a {@link SplatAsset}, and publishes a small service for putting
 * one in the scene.
 *
 * @param options Optional format override.
 * @returns The module, to be passed in `createEngine({ modules })`.
 *
 * @example
 * ```ts
 * import { createEngine } from 'gameable/core';
 * import { splat } from 'gameable/splat';
 *
 * const engine = await createEngine({ canvas, manifest: '/assets.json', modules: [splat()] });
 * engine.get('splat').add('arena');
 * engine.start();
 * ```
 */
export function splat(options: SplatModuleOptions = {}): EngineModule {
  const loaded = new Map<string, SplatAsset>();
  const added: ReturnType<typeof createSplatObject>[] = [];

  return {
    id: 'splat',
    // After physics and gameplay: the world is scenery, nothing waits on it.
    order: 200,

    init(hostContext: HostContext) {
      const engineContext = requireRenderContext(hostContext, 'splat');
      initCountingSortPatch();
      engineContext.assets.registerLoader('splat', async (url, entry, loaderContext) => {
        const asset = await loadSplat(url, {
          format: options.format,
          signal: loaderContext.signal,
        });
        loaded.set(entry.id, asset);
        return asset;
      });

      const service: SplatService = {
        loaded,
        added,
        add(id, objectOptions) {
          const asset = loaded.get(id);
          if (asset === undefined) {
            throw new Error(
              `@gameable/splat: asset "${id}" is not loaded; await assets.load('${id}') or ` +
                'preload its tag first',
            );
          }
          const object = createSplatObject(asset, { receiveShadows: true, ...objectOptions });
          engineContext.scene.add(object);
          added.push(object);
          return object;
        },
      };
      return service;
    },

    dispose() {
      for (const asset of loaded.values()) asset.geometry.dispose();
      loaded.clear();
      added.length = 0;
    },
  };
}
