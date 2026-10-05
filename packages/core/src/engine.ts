/**
 * `createEngine` — the host bootstrap.
 *
 * Boot order is not negotiable and is the reason this function is async:
 *
 * 1. `initWebGPUPatches()`, before anything can create a `GPUDevice`.
 * 2. `new WebGPURenderer(...)` and `await renderer.init()`, which creates the
 *    one device everything else borrows.
 * 3. Capability flags, decided from the backend three actually got.
 * 4. The asset manifest, so modules can resolve ids during `init`.
 * 5. Module `init`, in `order`.
 * 6. The loop.
 *
 * Teardown runs the same list backwards.
 */
import type { AssetLoaderMap, AssetManifest, AssetRegistry } from '@gameable/assets';
import { createAssetRegistry, createDefaultLoaders } from '@gameable/assets';
import type { PerspectiveCamera, Scene } from 'three/webgpu';
import { WebGPURenderer } from 'three/webgpu';

import type { EngineCaps, EngineConfig, EngineContext, RendererBackend } from './context.js';
import type { DebugOverlay } from './debug/overlay.js';
import { Engine as EngineHost, resolveManifest } from './engine/index.js';
import type { EngineEventMap, Events } from './events.js';
import type { FixedLoop } from './loop.js';
import { DEFAULT_MAX_SUBSTEPS } from './loop.js';
import type { EngineModule, EngineServices, ModuleRegistry } from './module.js';
import type { SceneGraph } from './scene/graph.js';
import { initWebGPUPatches } from './webgpu/patches.js';

/** Renderer options accepted by {@link createEngine}. */
export interface EngineRendererOptions {
  /**
   * Which backend to target.
   *
   * `auto` takes WebGPU when the browser has it and falls back to WebGL
   * otherwise. `webgpu` refuses to boot without it. `webgl` forces the fallback,
   * which is useful for reproducing what a WebGL player sees — characters are
   * unavailable there.
   */
  readonly backend?: RendererBackend;
  /** Request MSAA. Defaults to `true`. */
  readonly antialias?: boolean;
  /** Upper bound on `devicePixelRatio`. Defaults to `2`. */
  readonly pixelRatioCap?: number;
}

/** Options accepted by {@link createEngine}. */
export interface CreateEngineOptions {
  /** The canvas to render into. The engine observes it for size changes. */
  readonly canvas: HTMLCanvasElement;
  /**
   * The asset manifest: a URL to fetch, or an already-parsed document.
   *
   * Omit for an engine with an empty registry, which is what the unit tests and
   * the splat viewer use.
   */
  readonly manifest?: string | AssetManifest | object;
  /** Modules to register, in any order; `order` decides the run order. */
  readonly modules?: readonly EngineModule[];
  /** Simulation rate. Defaults to `60`. */
  readonly fixedHz?: number;
  /** Most fixed steps one frame may run. Defaults to `5`. */
  readonly maxSubsteps?: number;
  /** Renderer options. */
  readonly renderer?: EngineRendererOptions;
  /** Create the F3 debug overlay. Defaults to `false`. */
  readonly debug?: boolean;
  /**
   * Asset loaders, replacing the built-in `gltf` and `audio` pair.
   *
   * Adding a type is `engine.ctx.assets.registerLoader(...)`, not this.
   */
  readonly loaders?: AssetLoaderMap;
  /** Draco decoder directory handed to the default `gltf` loader. */
  readonly dracoDecoderPath?: string;
  /** Basis transcoder directory handed to the default `gltf` loader. */
  readonly ktx2TranscoderPath?: string;
}

/** A booted engine. */
export interface Engine {
  /** The scene being rendered. */
  readonly scene: Scene;
  /** The camera being rendered from. */
  readonly camera: PerspectiveCamera;
  /** The initialised renderer. */
  readonly renderer: WebGPURenderer;
  /** The module context, for code that is not a module. */
  readonly ctx: EngineContext;
  /** The asset registry. */
  readonly assets: AssetRegistry;
  /** Entity-id to `Object3D` mapping, rooted in the scene. */
  readonly graph: SceneGraph;
  /** The engine event bus. */
  readonly events: Events<EngineEventMap>;
  /** The module registry. */
  readonly modules: ModuleRegistry;
  /** The debug overlay, when `debug` was set. */
  readonly overlay: DebugOverlay | null;
  /** The fixed-step loop. */
  readonly loop: FixedLoop;
  /** Whether the loop is running. */
  readonly running: boolean;

  /**
   * Start the loop.
   */
  start(): void;

  /**
   * Stop the loop. Modules keep their resources; `start` resumes.
   */
  stop(): void;

  /**
   * Stop, dispose every module in reverse order, then the renderer.
   *
   * @returns Resolves once the renderer has released its device.
   */
  dispose(): Promise<void>;

  /**
   * Look up a module's service.
   *
   * @param id Service id, typed through `EngineServices`.
   * @returns The service.
   */
  get<K extends keyof EngineServices>(id: K): EngineServices[K];

  /**
   * Resize the drawing buffer and the camera.
   *
   * Called automatically by the canvas `ResizeObserver`; call it yourself only
   * when you manage the canvas size some other way.
   *
   * @param width CSS width in pixels.
   * @param height CSS height in pixels.
   */
  resize(width: number, height: number): void;
}

/** Default upper bound on `devicePixelRatio`. */
export const DEFAULT_PIXEL_RATIO_CAP = 2;

/**
 * Apply the documented defaults to the engine options.
 *
 * Exported for the unit tests; `createEngine` is the real entry point.
 *
 * @param options Options as the caller wrote them.
 * @returns The resolved configuration.
 *
 * @example
 * ```ts
 * import { resolveEngineConfig } from 'gameable/core';
 *
 * const config = resolveEngineConfig({ fixedHz: 120 });
 * console.log(config.fixedDt); // 0.008333…
 * ```
 */
export function resolveEngineConfig(
  options: Omit<CreateEngineOptions, 'canvas'> = {},
): EngineConfig {
  const fixedHz = options.fixedHz ?? 60;
  if (!(fixedHz > 0)) throw new RangeError('createEngine: fixedHz must be greater than 0');
  return {
    fixedHz,
    fixedDt: 1 / fixedHz,
    maxSubsteps: options.maxSubsteps ?? DEFAULT_MAX_SUBSTEPS,
    backend: options.renderer?.backend ?? 'auto',
    antialias: options.renderer?.antialias ?? true,
    pixelRatioCap: options.renderer?.pixelRatioCap ?? DEFAULT_PIXEL_RATIO_CAP,
    debug: options.debug ?? false,
    headless: false,
  };
}

/**
 * Whether a renderer ended up on a real WebGPU backend.
 *
 * three sets `isWebGPUBackend` on `WebGPUBackend` and `isWebGLBackend` on the
 * fallback, but neither class is exported from `three/webgpu`, so this is a
 * duck-type check rather than an `instanceof`.
 *
 * @param renderer An initialised renderer.
 * @returns True on WebGPU, false on the WebGL fallback.
 *
 * @example
 * ```ts
 * import { isWebGPUBackend } from 'gameable/core';
 * import { WebGPURenderer } from 'three/webgpu';
 *
 * const renderer = new WebGPURenderer({ canvas: document.createElement('canvas') });
 * await renderer.init();
 * console.log(isWebGPUBackend(renderer));
 * ```
 */
export function isWebGPUBackend(renderer: WebGPURenderer): boolean {
  const backend = renderer.backend as unknown as
    { isWebGPUBackend?: boolean; isWebGLBackend?: boolean } | undefined;
  if (backend === undefined) return false;
  if (typeof backend.isWebGPUBackend === 'boolean') return backend.isWebGPUBackend;
  // Older/unknown backends: anything that is not the WebGL fallback is WebGPU.
  return backend.isWebGLBackend !== true;
}

/**
 * Boot an engine around a canvas.
 *
 * @param options Canvas, manifest, modules, loop rate and renderer settings.
 * @returns The booted engine. The loop is not running; call `start()`.
 *
 * @example
 * ```ts
 * import { createEngine } from 'gameable/core';
 *
 * const canvas = document.querySelector('canvas')!;
 * const engine = await createEngine({
 *   canvas,
 *   manifest: '/assets/assets.json',
 *   modules: [],
 *   fixedHz: 60,
 *   renderer: { backend: 'auto' },
 *   debug: import.meta.env?.DEV === true,
 * });
 * engine.start();
 * ```
 */
export async function createEngine(options: CreateEngineOptions): Promise<Engine> {
  const config = resolveEngineConfig(options);
  const { canvas } = options;

  // 1. Patch before anything can ask for a device.
  initWebGPUPatches();

  // 2. The renderer owns the device; nobody else calls requestAdapter.
  const renderer = new WebGPURenderer({
    canvas,
    antialias: config.antialias,
    forceWebGL: config.backend === 'webgl',
  });
  await renderer.init();

  // 3. Capabilities, from the backend three actually got.
  const webgpu = isWebGPUBackend(renderer);
  if (config.backend === 'webgpu' && !webgpu) {
    await renderer.dispose();
    throw new Error(
      "createEngine: renderer.backend is 'webgl' but backend 'webgpu' was required; " +
        "use backend 'auto' to allow the fallback",
    );
  }
  const caps: EngineCaps = { webgpu, characters: webgpu };

  // 4. Assets, so modules can resolve ids during init.
  const manifest = await resolveManifest(options.manifest);
  const defaults =
    options.loaders === undefined
      ? createDefaultLoaders({
          renderer,
          dracoDecoderPath: options.dracoDecoderPath,
          ktx2TranscoderPath: options.ktx2TranscoderPath,
        })
      : null;
  const assets = createAssetRegistry({
    manifest,
    loaders: options.loaders ?? defaults?.loaders ?? {},
  });

  // 5. Module init, in order; then the overlay, the sRGB pass and the canvas size.
  return EngineHost.create(
    { canvas, renderer, config, caps, assets, defaults },
    options.modules ?? [],
  );
}
