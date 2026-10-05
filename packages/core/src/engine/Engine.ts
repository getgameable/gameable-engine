/**
 * `Engine` — the engine with a renderer: {@link EngineBase} plus the scene, the
 * camera, the scene graph, the sRGB pass, the debug overlay, a `ResizeObserver`
 * on the canvas, and frames scheduled on `requestAnimationFrame`.
 *
 * `createEngine` builds the renderer, decides the capabilities and builds the
 * asset registry, then hands them to {@link Engine.create}.
 */
import type { DefaultLoaders } from '@gameable/assets';
import { PerspectiveCamera, Scene } from 'three/webgpu';
import type { WebGPURenderer } from 'three/webgpu';

import type { EngineContext } from '../context.js';
import type { DebugOverlay } from '../debug/overlay.js';
import { createDebugOverlay } from '../debug/overlay.js';
import type { Engine as EngineApi } from '../engine.js';
import type { EngineModule } from '../module.js';
import type { SrgbPass } from '../render/srgbPass.js';
import { attachSrgbPass } from '../render/srgbPass.js';
import { SceneGraph } from '../scene/graph.js';
import type { EngineBaseParts } from './EngineBase.js';
import { EngineBase } from './EngineBase.js';

/** What `createEngine` hands {@link Engine.create}. */
export interface EngineParts extends EngineBaseParts {
  /** The canvas the renderer draws into; observed for size changes. */
  readonly canvas: HTMLCanvasElement;
  /** The initialised renderer. */
  readonly renderer: WebGPURenderer;
  /** The default loaders behind `assets`, released on dispose; null when the caller supplied loaders. */
  readonly defaults: DefaultLoaders | null;
}

/** The engine with a renderer. Construct it through `createEngine`. */
export class Engine extends EngineBase<EngineContext> implements EngineApi {
  /** The scene being rendered. */
  readonly scene: Scene;
  /** The camera being rendered from. */
  readonly camera: PerspectiveCamera;
  /** The initialised renderer. */
  readonly renderer: WebGPURenderer;
  /** Entity-id to `Object3D` mapping, rooted in the scene. */
  readonly graph: SceneGraph;

  private readonly canvas: HTMLCanvasElement;
  private readonly defaults: DefaultLoaders | null;
  private debugOverlay: DebugOverlay | null = null;
  private srgbPass: SrgbPass | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private rafId = 0;
  private lastFrameMs = 0;
  private lastWidth = 0;
  private lastHeight = 0;
  private lastPixelRatio = 0;

  /**
   * Build the engine and init its modules.
   *
   * @param parts Renderer, canvas, config, capabilities and assets.
   * @param modules Modules in any order; `order` decides the run order.
   * @returns The booted engine. The loop is not running; call `start()`.
   */
  static async create(parts: EngineParts, modules: readonly EngineModule[]): Promise<Engine> {
    const engine = new Engine(parts);
    await engine.boot(modules);
    engine.attach();
    return engine;
  }

  /** @param parts Renderer, canvas, config, capabilities and assets. */
  private constructor(parts: EngineParts) {
    const scene = new Scene();
    const camera = new PerspectiveCamera(70, 1, 0.1, 1000);
    super(parts, { scene, camera, renderer: parts.renderer });
    this.scene = scene;
    this.camera = camera;
    this.renderer = parts.renderer;
    this.graph = new SceneGraph(scene);
    this.canvas = parts.canvas;
    this.defaults = parts.defaults;
  }

  /**
   * The debug overlay.
   *
   * @returns The overlay when `debug` was set, otherwise null.
   */
  get overlay(): DebugOverlay | null {
    return this.debugOverlay;
  }

  /**
   * Stop, dispose every module in reverse order, then the renderer.
   *
   * @returns Resolves once the renderer has released its device.
   */
  override async dispose(): Promise<void> {
    // Deliberately not super.dispose(): renderer teardown interleaves with the base's.
    this.stop();
    this.resizeObserver?.disconnect();
    this.debugOverlay?.dispose();
    this.modules.disposeAll();
    this.srgbPass?.dispose();
    this.graph.dispose();
    this.assets.dispose();
    this.defaults?.dispose();
    this.events.clear();
    await this.renderer.dispose();
  }

  /**
   * Resize the drawing buffer and the camera.
   *
   * Called automatically by the canvas `ResizeObserver`; call it yourself only
   * when you manage the canvas size some other way.
   *
   * @param width CSS width in pixels.
   * @param height CSS height in pixels.
   */
  resize(width: number, height: number): void {
    const w = Math.max(1, Math.floor(width));
    const h = Math.max(1, Math.floor(height));
    const dpr = Math.min(
      typeof devicePixelRatio === 'number' ? devicePixelRatio : 1,
      this.ctx.config.pixelRatioCap,
    );
    // The observer fires for layout passes that did not change the size.
    if (w === this.lastWidth && h === this.lastHeight && dpr === this.lastPixelRatio) return;
    this.lastWidth = w;
    this.lastHeight = h;
    this.lastPixelRatio = dpr;
    this.renderer.setPixelRatio(dpr);
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.events.emit('engine:resize', { width: w, height: h });
  }

  /**
   * Draw one frame.
   *
   * `renderer.render()` is the synchronous path and is safe here because
   * `renderer.init()` has already been awaited during boot; `renderAsync` is
   * deprecated in three r186.
   */
  protected override render(): void {
    this.renderer.render(this.scene, this.camera);
  }

  protected override schedule(): void {
    this.rafId = requestAnimationFrame(this.frame);
  }

  protected override unschedule(): void {
    cancelAnimationFrame(this.rafId);
    this.rafId = 0;
  }

  /**
   * One animation frame.
   *
   * @param nowMs Timestamp supplied by `requestAnimationFrame`.
   */
  private readonly frame = (nowMs: number): void => {
    if (!this.running) return;
    this.rafId = requestAnimationFrame(this.frame);
    this.step(nowMs);
    if (this.debugOverlay !== null) {
      this.debugOverlay.sample(this.lastFrameMs === 0 ? 0 : nowMs - this.lastFrameMs, nowMs);
      this.lastFrameMs = nowMs;
    }
  };

  /** After module init: the overlay, the sRGB pass, and the canvas size. */
  private attach(): void {
    const { renderer, canvas } = this;
    if (this.ctx.config.debug) {
      this.debugOverlay = createDebugOverlay({
        renderer,
        backendName: this.ctx.caps.webgpu ? 'webgpu' : 'webgl',
      });
    }
    // sRGB-trained splats (characters, places) blend on sRGB values, drawn by a
    // pass hooked into renderer.render.
    this.srgbPass = attachSrgbPass(renderer, this.scene);

    // Track the canvas rather than the window: a canvas in a flex layout resizes
    // without the window ever firing `resize`.
    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver(() => {
        this.resize(canvas.clientWidth, canvas.clientHeight);
      });
      this.resizeObserver.observe(canvas);
    }
    this.resize(canvas.clientWidth || 1, canvas.clientHeight || 1);
  }
}
