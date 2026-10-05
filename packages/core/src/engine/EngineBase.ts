/**
 * `EngineBase` — what every engine shares, with or without a renderer: the
 * module registry, the fixed loop, the clock, the events, the asset registry,
 * the per-step hook calls and the module context.
 *
 * Subclasses decide two things only: how frames are scheduled (`schedule` /
 * `unschedule`) and what a frame draws (`render`). `Engine` schedules on
 * `requestAnimationFrame` and draws with three; `HeadlessEngine` schedules on a
 * timer and draws nothing.
 */
import type { AssetRegistry } from '@gameable/assets';

import type { EngineCaps, EngineConfig, HostContext } from '../context.js';
import type { EngineEventMap, Events } from '../events.js';
import { createEvents } from '../events.js';
import type { FixedLoop, FrameTiming } from '../loop.js';
import { createFixedLoop } from '../loop.js';
import type { EngineModule, EngineServices, ModuleRegistry } from '../module.js';
import { createModuleRegistry } from '../module.js';
import type { MutableTime, Time } from '../time.js';
import { createTime } from '../time.js';

/** What a subclass hands {@link EngineBase} to build on. */
export interface EngineBaseParts {
  /** The resolved engine options. */
  readonly config: EngineConfig;
  /** What the host can do. */
  readonly caps: EngineCaps;
  /** The asset registry, already built from the manifest. */
  readonly assets: AssetRegistry;
}

/**
 * The shared engine core.
 *
 * @template C The context modules receive: `HostContext`, or a wider one that
 *   adds what the subclass owns (the scene, camera and renderer).
 */
export abstract class EngineBase<C extends HostContext = HostContext> {
  /** The module context, for code that is not a module. */
  readonly ctx: C;
  /** The asset registry. */
  readonly assets: AssetRegistry;
  /** The engine event bus. */
  readonly events: Events<EngineEventMap>;
  /** The module registry. */
  readonly modules: ModuleRegistry;
  /** The fixed-step loop. */
  readonly loop: FixedLoop;

  /** The engine's writable handle on the clock; `ctx.time` is the same object. */
  protected readonly clock: MutableTime;

  private isRunning = false;
  /** The `engine:frame` payload, mutated in place. Listeners must not retain it. */
  private readonly framePayload = { frame: 0, dtReal: 0, alpha: 0, substeps: 0 };

  /**
   * @param parts Config, capabilities and the asset registry.
   * @param extra What the subclass adds to the module context, beyond `HostContext`.
   */
  protected constructor(parts: EngineBaseParts, extra: Omit<C, keyof HostContext>) {
    const { config, caps, assets } = parts;
    const events = createEvents<EngineEventMap>();
    const time = createTime(config.fixedDt);
    const modules = createModuleRegistry();
    this.assets = assets;
    this.events = events;
    this.clock = time;
    this.modules = modules;

    const host: HostContext = {
      assets,
      events,
      time,
      config,
      caps,
      registerService(id, service) {
        modules.registerService(id, service);
      },
      get(id) {
        return modules.get(id);
      },
    };
    this.ctx = { ...extra, ...host } as C;

    this.loop = createFixedLoop({
      fixedDt: config.fixedDt,
      maxSubsteps: config.maxSubsteps,
      // A fixed step is always `fixedDt` long. Time scale decides how many of
      // them a frame buys (see `FixedLoop.timeScale`), so physics and the guest
      // see one constant `dt` at every speed and a recording replays.
      fixedUpdate(dt) {
        time.elapsed += dt;
        const hooks = modules.fixedUpdateHooks;
        for (let i = 0; i < hooks.length; i += 1) hooks[i].fixedUpdate?.(dt);
      },
      update(dtReal, alpha) {
        const scaled = dtReal * time.timeScale;
        const hooks = modules.updateHooks;
        for (let i = 0; i < hooks.length; i += 1) hooks[i].update?.(scaled, alpha);
      },
      render: () => {
        this.render();
      },
    });
  }

  /**
   * The engine clock, read-only.
   *
   * @returns The same object as `ctx.time`.
   */
  get time(): Time {
    return this.clock;
  }

  /**
   * Whether the loop is running.
   *
   * @returns True between `start()` and `stop()`.
   */
  get running(): boolean {
    return this.isRunning;
  }

  /** Start the loop. A second call while running does nothing. */
  start(): void {
    if (this.isRunning) return;
    this.isRunning = true;
    this.loop.reset();
    this.schedule();
    this.events.emit('engine:start', undefined);
  }

  /** Stop the loop. Modules keep their resources; `start` resumes. */
  stop(): void {
    if (!this.isRunning) return;
    this.isRunning = false;
    this.unschedule();
    this.events.emit('engine:stop', undefined);
  }

  /**
   * Run one frame: the begin-frame hooks, as many fixed steps as `nowMs` buys,
   * the update hooks, the render, the end-frame hooks, then `engine:frame`.
   *
   * @param nowMs A monotonic wall clock in milliseconds. The first call after
   *   `start()` (or ever) only sets the baseline and runs no fixed step.
   * @returns What the frame did. The loop's one reused record; do not retain it.
   */
  step(nowMs: number): FrameTiming {
    const time = this.clock;
    time.now = nowMs;
    time.renderFrame += 1;
    this.loop.timeScale = time.timeScale;

    const begin = this.modules.beginFrameHooks;
    for (let i = 0; i < begin.length; i += 1) begin[i].beginFrame?.();
    const timing = this.loop.step(nowMs);
    const end = this.modules.endFrameHooks;
    for (let i = 0; i < end.length; i += 1) end[i].endFrame?.();

    if (this.events.listenerCount('engine:frame') > 0) {
      const payload = this.framePayload;
      payload.frame = time.renderFrame;
      payload.dtReal = timing.dtReal;
      payload.alpha = timing.alpha;
      payload.substeps = timing.substeps;
      this.events.emit('engine:frame', payload);
    }
    return timing;
  }

  /**
   * Look up a module's service.
   *
   * @param id Service id, typed through `EngineServices`.
   * @returns The service.
   */
  get<K extends keyof EngineServices>(id: K): EngineServices[K] {
    return this.modules.get(id);
  }

  /**
   * Stop, dispose every module in reverse order, then the assets and the
   * event listeners. Subclasses that own more override this.
   *
   * @returns Resolves once everything is released; rejects if a module's
   *   `dispose` threw.
   */
  dispose(): Promise<void> {
    return new Promise((resolve) => {
      this.stop();
      this.modules.disposeAll();
      this.assets.dispose();
      this.events.clear();
      resolve();
    });
  }

  /**
   * Register the modules and run their `init`, in `order`. Called once, by the
   * subclass's factory, before the engine is handed out.
   *
   * @param modules Modules in any order.
   */
  protected async boot(modules: readonly EngineModule[]): Promise<void> {
    for (const module of modules) this.modules.register(module);
    await this.modules.initAll(this.ctx);
  }

  /** Draw the frame. Runs once per `step`, after the update hooks. */
  protected render(): void {
    // Nothing to draw without a renderer.
  }

  /** Arrange for frames to be stepped; `start` calls this. */
  protected abstract schedule(): void;

  /** Cancel what `schedule` arranged; `stop` calls this. */
  protected abstract unschedule(): void;
}
