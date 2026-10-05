import type { EngineContext, EngineModule } from '@gameable/core';
import type { Scene } from 'three/webgpu';

import type { DebugDraw } from './debugDraw.js';
import { loadJolt, type LoadJoltOptions } from './jolt.js';
import { createPhysicsWorld, type PhysicsWorld, type PhysicsWorldOptions } from './world.js';

/** Options for {@link physics}. */
export interface PhysicsOptions extends PhysicsWorldOptions, LoadJoltOptions {
  /**
   * Collision steps per fixed step. One is right for a 60 Hz simulation; raise
   * it only if fast bodies tunnel and `flags.ccd` was not enough.
   */
  substeps?: number;
}

/**
 * The physics service, published by the engine under the id `physics`.
 *
 * It is the {@link PhysicsWorld} plus the debug view, so
 * `engine.get('physics').raycast(...)` works directly.
 */
export interface PhysicsService extends PhysicsWorld {
  /**
   * Attach or detach a wireframe debug view.
   *
   * Pass a scene to attach, `null` to detach and free the geometry. The line
   * buffer is rebuilt only when the set of bodies changes; the per-frame cost
   * is a transform of the cached corners in `update`, with no allocation.
   *
   * @param scene The scene to draw into, or null to remove the view.
   */
  debugWireframe(scene: Scene | null): void;
}

/**
 * What `physics:stepped` carries.
 *
 * The object is reused, so a listener must read it and not retain it — the
 * event fires inside `fixedUpdate` and allocating one of these per step is the
 * thing the whole phase is about.
 *
 * @example
 * ```ts
 * import type { PhysicsSteppedEvent } from 'gameable/physics';
 *
 * let rows = 0;
 * engine.events.on('physics:stepped', (e: PhysicsSteppedEvent) => {
 *   rows = e.movingBodyCount; // read it now; the object is rewritten next step
 * });
 * ```
 */
export interface PhysicsSteppedEvent {
  /** Length of the step that just ran, in seconds. */
  dt: number;
  /** Rows the next {@link PhysicsService.readBodies} will fill. */
  movingBodyCount: number;
  /** Contact events this step queued for `drainContacts`. */
  contacts: number;
}

declare module '@gameable/core' {
  interface EngineServices {
    /** The Jolt physics world. */
    physics: PhysicsService;
  }

  interface EngineEventMap {
    /**
     * The simulation advanced one fixed step and the world is readable.
     *
     * Fired at the end of the physics module's `fixedUpdate`, which is the one
     * moment body state is post-step and nothing has moved since. The host
     * loop listens for it and copies the moving bodies' rows straight into the
     * transform store, so a body-driven entity never crosses the wasm boundary
     * on its way to the screen. The payload object is reused; never retain it.
     */
    'physics:stepped': PhysicsSteppedEvent;
  }
}

/**
 * The Jolt physics `EngineModule`.
 *
 * Registered in the engine's module list, it loads the Jolt wasm module in
 * `init`, publishes the world as the `physics` service, and steps the
 * simulation once per fixed step — never in `update`, because reading body
 * state there gives you an interpolated pose, not a simulated one.
 *
 * @param options Gravity, capacity, layer tuning and the wasm location.
 * @returns A module to hand to `createEngine({ modules: [...] })`.
 *
 * @example
 * ```ts
 * import { createEngine } from 'gameable/core';
 * import { physics } from 'gameable/physics';
 *
 * const engine = await createEngine({
 *   canvas,
 *   manifest,
 *   modules: [physics({ gravity: [0, -9.81, 0] })],
 * });
 * const hit = engine.get('physics').raycast([0, 2, 0], [0, -1, 0], 10, 0xffff);
 * ```
 */
export function physics(options: PhysicsOptions = {}): EngineModule {
  const substeps = options.substeps ?? 1;
  let world: PhysicsWorld | null = null;
  let service: PhysicsService | null = null;

  // Debug view state. Null until `debugWireframe` is called; the view's code,
  // and three.js with it, is loaded lazily so headless hosts never import it.
  let debugScene: Scene | null = null;
  let debug: DebugDraw | null = null;

  /** The engine event bus, for `physics:stepped`. Null before `init`. */
  let events: EngineContext['events'] | null = null;
  /** The one reused `physics:stepped` payload; see {@link PhysicsSteppedEvent}. */
  const stepped: PhysicsSteppedEvent = { dt: 0, movingBodyCount: 0, contacts: 0 };

  return {
    id: 'physics',
    order: 0,

    async init(ctx): Promise<object> {
      events = ctx.events;
      const jolt = await loadJolt(options);
      const live = createPhysicsWorld(jolt, options);
      world = live;
      // The service *is* the world, with the debug view bolted on. Defining the
      // method on the instance keeps every getter and private field intact,
      // which a delegating wrapper object would not.
      Object.defineProperty(live, 'debugWireframe', {
        value: (scene: Scene | null): void => {
          if (scene === null) {
            debug?.detach();
            debugScene = null;
            return;
          }
          debugScene = scene;
          if (debug === null) {
            // Two real dynamic imports: three stays out of any bundle that never draws.
            void Promise.all([import('./debugDraw.js'), import('three/webgpu')])
              .then(([{ createDebugDraw }, three]) => {
                if (world === null || debugScene === null || debug !== null) return;
                debug = createDebugDraw(world, three);
                debug.attach(debugScene);
              })
              .catch((err: unknown) => {
                console.error('physics: debug wireframe unavailable', err);
              });
            return;
          }
          debug.attach(scene);
        },
        enumerable: true,
      });
      service = live as PhysicsService;
      return service;
    },

    fixedUpdate(dt: number): void {
      const live = world;
      if (live === null) return;
      const contacts = live.step(dt, substeps);
      // Announced rather than polled, because the one interesting moment is
      // right here: the bodies are post-step and nothing has touched them yet.
      if (events !== null) {
        stepped.dt = dt;
        stepped.movingBodyCount = live.movingBodyCount;
        stepped.contacts = contacts;
        events.emit('physics:stepped', stepped);
      }
    },

    update(): void {
      // The wireframe is the only per-frame work this module does, and a game
      // that never asked for it must pay nothing at all.
      debug?.update();
    },

    dispose(): void {
      debug?.dispose();
      debug = null;
      debugScene = null;
      events = null;
      world?.dispose();
      world = null;
      service = null;
    },
  };
}
