/**
 * The objects every module is handed at `init`.
 *
 * {@link HostContext} is the surface every host has, with or without a
 * renderer: the asset registry, the event bus, the clock, the resolved
 * configuration and the capability flags. {@link EngineContext} adds the scene,
 * the camera and the renderer. A module that needs something not on here is
 * asking for an engine change, not a workaround.
 */
import type { AssetRegistry } from '@gameable/assets';
import type { PerspectiveCamera, Scene, WebGPURenderer } from 'three/webgpu';

import type { EngineEventMap, Events } from './events.js';
import { ModuleError, type EngineServices } from './module.js';
import type { Time } from './time.js';

/** Which three.js backend the renderer should target. */
export type RendererBackend = 'auto' | 'webgpu' | 'webgl';

/** What the host turned out to be able to do, decided once after `renderer.init()`. */
export interface EngineCaps {
  /**
   * True when the renderer got a real WebGPU backend rather than the WebGL fallback.
   * Always `false` on a headless host.
   */
  readonly webgpu: boolean;
  /**
   * True when splat characters can run.
   *
   * Characters need compute shaders and a shared `GPUDevice`, so this tracks
   * `webgpu` exactly. Check it before calling `createCharacter`. Always
   * `false` on a headless host.
   */
  readonly characters: boolean;
}

/** The engine options after defaults were applied. */
export interface EngineConfig {
  /** Simulation rate in hertz. */
  readonly fixedHz: number;
  /** Length of one fixed step, in seconds: `1 / fixedHz`. */
  readonly fixedDt: number;
  /** Most fixed steps one frame may run. */
  readonly maxSubsteps: number;
  /** Backend that was requested (not necessarily the one that was obtained). */
  readonly backend: RendererBackend;
  /** Whether MSAA was requested. */
  readonly antialias: boolean;
  /** Upper bound applied to `devicePixelRatio`. */
  readonly pixelRatioCap: number;
  /** Whether the debug overlay was created. */
  readonly debug: boolean;
  /** True when the host has no renderer, scene or camera (a server tick). */
  readonly headless: boolean;
}

/**
 * What every host has, with or without a renderer.
 *
 * @example
 * ```ts
 * import 'gameable/physics';
 * import type { HostContext } from 'gameable/core';
 *
 * export function init(ctx: HostContext) {
 *   const physics = ctx.get('physics');
 *   console.log(ctx.time.fixedDt, physics);
 * }
 * ```
 */
export interface HostContext {
  /** The asset registry built from the manifest. */
  readonly assets: AssetRegistry;
  /** The engine event bus. */
  readonly events: Events<EngineEventMap>;
  /** The engine clock. */
  readonly time: Time;
  /** The resolved engine options. */
  readonly config: EngineConfig;
  /** What this host can actually do. */
  readonly caps: EngineCaps;

  /**
   * Publish a service under an id, so other modules can `get` it.
   *
   * Equivalent to returning the service from `init`; use this when a module
   * exposes something before it has finished initialising, or exposes nothing
   * but wants to register under a different id.
   *
   * @param id Service id, matching a key of `EngineServices`.
   * @param service The service object.
   */
  registerService(id: string, service: object): void;

  /**
   * Look up another module's service.
   *
   * Only valid after that module's `init` has run, which `order` controls.
   *
   * @param id Service id.
   * @returns The service.
   */
  get<K extends keyof EngineServices>(id: K): EngineServices[K];
}

/**
 * A host that renders: the scene, the camera and the renderer on top of {@link HostContext}.
 *
 * @example
 * ```ts
 * import { requireRenderContext, type HostContext } from 'gameable/core';
 *
 * export function init(host: HostContext) {
 *   const ctx = requireRenderContext(host, 'splat');
 *   ctx.scene.add(ctx.camera);
 * }
 * ```
 */
export interface EngineContext extends HostContext {
  /** The scene the engine renders. */
  readonly scene: Scene;
  /** The camera the engine renders with. Camera rigs drive this. */
  readonly camera: PerspectiveCamera;
  /** The initialised renderer. Its `backend.device` is the one shared GPU device. */
  readonly renderer: WebGPURenderer;
}

/**
 * Assert a module is running under a renderer.
 *
 * @param ctx The context a module was handed.
 * @param moduleId The module asking, for the error message.
 * @returns The same context, typed as rendering.
 * @throws {ModuleError} When the host is headless.
 *
 * @example
 * ```ts
 * import { requireRenderContext, type HostContext } from 'gameable/core';
 *
 * declare const host: HostContext;
 * try {
 *   const { scene } = requireRenderContext(host, 'splat');
 *   console.log(scene.children.length);
 * } catch (error) {
 *   console.log('headless host:', (error as Error).message);
 * }
 * ```
 */
export function requireRenderContext(ctx: HostContext, moduleId: string): EngineContext {
  if ((ctx as Partial<EngineContext>).renderer !== undefined) return ctx as EngineContext;
  throw new ModuleError(moduleId, `module "${moduleId}" needs a renderer and cannot run headless`);
}
