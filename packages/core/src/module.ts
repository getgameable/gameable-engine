/**
 * Engine modules and the registry that drives them.
 *
 * Every host subsystem — physics, input, audio, splats, characters — is an
 * {@link EngineModule}. The engine owns the loop; modules own their resources.
 */
import type { HostContext } from './context.js';

/**
 * The typed service table, empty by design.
 *
 * A package that exposes a service merges its id into this interface, and
 * `engine.get('physics')` is then typed with no cast at the call site:
 *
 * ```ts
 * // packages/physics-jolt/src/index.ts
 * declare module 'gameable/core' {
 *   interface EngineServices {
 *     physics: PhysicsService;
 *   }
 * }
 * ```
 *
 * The merge is global, so importing the package is enough to type the lookup.
 * Core deliberately declares nothing here: it must not know what exists.
 */
// The augmentation target has to start empty; that is the pattern.
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface EngineServices {}

/**
 * One host subsystem.
 *
 * `init` runs once, in `order`. `dispose` runs in reverse order and must
 * release everything the module took. The per-frame hooks are optional and are
 * called only on the modules that implement them, so an empty hook costs
 * nothing.
 *
 * Nothing in `beginFrame`, `fixedUpdate`, `update` or `endFrame` may allocate:
 * they run at least 60 times a second.
 */
export interface EngineModule {
  /** Unique id. Also the service id when `init` returns a service. */
  readonly id: string;
  /**
   * Sort key. Lower runs first; equal keys keep registration order.
   *
   * Rough convention: input `-100`, gameplay `-50`, physics `0`, rendering
   * helpers `200`. Gameplay runs before physics so that the commands a guest
   * tick emits are simulated by the step that follows rather than the next one.
   */
  readonly order?: number;

  /**
   * Acquire resources.
   *
   * @param ctx The host surface.
   * @returns Nothing, or the service to publish under `id`.
   */
  // `void` in the union is deliberate: a module may return nothing at all, or
  // the service it wants registered under `id`.
  // eslint-disable-next-line @typescript-eslint/no-invalid-void-type
  init(ctx: HostContext): void | object | Promise<void | object>;

  /** Run before the frame's fixed steps. Input capture lives here. */
  beginFrame?(): void;

  /**
   * Run once per fixed step.
   *
   * @param dt Always `ctx.config.fixedDt`, whatever `time.timeScale` is;
   *   time scale changes how many steps a frame runs, not their length.
   */
  fixedUpdate?(dt: number): void;

  /**
   * Run once per frame, after the fixed steps and before rendering.
   *
   * @param dt Clamped wall-clock seconds since the previous frame, scaled by
   *   `time.timeScale`.
   * @param alpha Interpolation factor in `[0, 1)` for smoothing transforms.
   */
  update?(dt: number, alpha: number): void;

  /** Run after rendering. Input's end-of-frame bookkeeping lives here. */
  endFrame?(): void;

  /** Release everything this module took. */
  dispose(): void;
}

/** Holds modules, orders them, initialises them and takes them down again. */
export interface ModuleRegistry {
  /** Registered modules in run order. */
  readonly modules: readonly EngineModule[];
  /** Modules implementing `beginFrame`, in run order. */
  readonly beginFrameHooks: readonly EngineModule[];
  /** Modules implementing `fixedUpdate`, in run order. */
  readonly fixedUpdateHooks: readonly EngineModule[];
  /** Modules implementing `update`, in run order. */
  readonly updateHooks: readonly EngineModule[];
  /** Modules implementing `endFrame`, in run order. */
  readonly endFrameHooks: readonly EngineModule[];

  /**
   * Add a module. Must happen before {@link ModuleRegistry.initAll}.
   *
   * @param module The module.
   */
  register(module: EngineModule): void;

  /**
   * Publish a service under an id.
   *
   * @param id Service id.
   * @param service The service object.
   */
  registerService(id: string, service: object): void;

  /**
   * Look up a service, typed through `EngineServices`.
   *
   * @param id Service id.
   * @returns The service.
   */
  get<K extends keyof EngineServices>(id: K): EngineServices[K];

  /**
   * Look up a service without the typed table.
   *
   * The escape hatch for code that does not know the id at compile time, and
   * for core itself, which must not know what modules exist.
   *
   * @param id Service id.
   * @returns The service, or `undefined` when nothing is registered.
   */
  tryGet(id: string): unknown;

  /**
   * Whether a service is registered under an id.
   *
   * @param id Service id.
   * @returns True when `get` would succeed.
   */
  has(id: string): boolean;

  /**
   * Initialise every module in order, awaiting each one.
   *
   * Modules are initialised sequentially, not in parallel, because `order` is a
   * dependency order: a module may `ctx.get` anything registered before it.
   *
   * @param ctx The host surface.
   * @returns Resolves once every module has initialised.
   */
  initAll(ctx: HostContext): Promise<void>;

  /**
   * Dispose every initialised module in reverse order.
   *
   * A throwing `dispose` is collected and rethrown at the end, so one bad
   * module cannot strand the others.
   */
  disposeAll(): void;
}

/** A module that could not be registered, initialised or found. */
export class ModuleError extends Error {
  /** The module or service id involved. */
  readonly moduleId: string;

  /**
   * Build a module error.
   *
   * @param moduleId Module or service id involved.
   * @param message What went wrong.
   * @param options Standard `Error` options, used to keep the cause.
   */
  constructor(moduleId: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ModuleError';
    this.moduleId = moduleId;
  }
}

/**
 * Build a module registry.
 *
 * @returns An empty registry.
 *
 * @example
 * ```ts
 * import { createModuleRegistry } from 'gameable/core';
 *
 * const registry = createModuleRegistry();
 * registry.register({ id: 'clock', order: -10, init: () => ({ t: 0 }), dispose: () => {} });
 * console.log(registry.modules[0]?.id); // 'clock'
 * ```
 */
export function createModuleRegistry(): ModuleRegistry {
  const modules: EngineModule[] = [];
  const services = new Map<string, object>();
  const initialised: EngineModule[] = [];
  let sealed = false;

  const beginFrameHooks: EngineModule[] = [];
  const fixedUpdateHooks: EngineModule[] = [];
  const updateHooks: EngineModule[] = [];
  const endFrameHooks: EngineModule[] = [];

  /**
   * Sort by `order`, then by registration index.
   *
   * `Array.prototype.sort` is already stable, so the index comparison is
   * belt and braces — and documentation of the intent.
   */
  function sort(): void {
    const index = new Map<EngineModule, number>();
    for (const [i, m] of modules.entries()) index.set(m, i);
    modules.sort((a, b) => {
      const byOrder = (a.order ?? 0) - (b.order ?? 0);
      return byOrder !== 0 ? byOrder : (index.get(a) ?? 0) - (index.get(b) ?? 0);
    });
  }

  const registry: ModuleRegistry = {
    modules,
    beginFrameHooks,
    fixedUpdateHooks,
    updateHooks,
    endFrameHooks,

    register(module) {
      if (sealed) {
        throw new ModuleError(module.id, `cannot register "${module.id}" after initAll()`);
      }
      if (modules.some((m) => m.id === module.id)) {
        throw new ModuleError(module.id, `a module with id "${module.id}" is already registered`);
      }
      modules.push(module);
      sort();
    },

    registerService(id, service) {
      if (services.has(id)) {
        throw new ModuleError(id, `a service is already registered under "${id}"`);
      }
      services.set(id, service);
    },

    get(id) {
      const name = id as string;
      const service = services.get(name);
      if (service === undefined) {
        const known = [...services.keys()].join(', ');
        throw new ModuleError(
          name,
          `no service "${name}"; registered: ${known === '' ? '(none)' : known}`,
        );
      }
      return service as EngineServices[typeof id];
    },

    tryGet(id) {
      return services.get(id);
    },

    has(id) {
      return services.has(id);
    },

    async initAll(ctx) {
      sealed = true;
      for (const module of modules) {
        let service: unknown;
        try {
          service = await module.init(ctx);
        } catch (cause) {
          throw new ModuleError(module.id, `module "${module.id}" failed to init`, { cause });
        }
        initialised.push(module);
        if (typeof service === 'object' && service !== null && !services.has(module.id)) {
          services.set(module.id, service);
        }
        if (module.beginFrame !== undefined) beginFrameHooks.push(module);
        if (module.fixedUpdate !== undefined) fixedUpdateHooks.push(module);
        if (module.update !== undefined) updateHooks.push(module);
        if (module.endFrame !== undefined) endFrameHooks.push(module);
      }
    },

    disposeAll() {
      const failures: unknown[] = [];
      for (let i = initialised.length - 1; i >= 0; i -= 1) {
        try {
          initialised[i]?.dispose();
        } catch (err) {
          failures.push(err);
        }
      }
      initialised.length = 0;
      beginFrameHooks.length = 0;
      fixedUpdateHooks.length = 0;
      updateHooks.length = 0;
      endFrameHooks.length = 0;
      services.clear();
      if (failures.length > 0) {
        throw new AggregateError(
          failures,
          `${String(failures.length)} module(s) failed to dispose`,
        );
      }
    },
  };

  return registry;
}
