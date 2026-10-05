/**
 * The `input` engine module: DOM capture plus an action map, wired into the
 * engine loop's `beginFrame`, `fixedUpdate` and `endFrame`.
 *
 * The split matters: `beginFrame` runs once per *rendered* frame and only
 * accumulates, while `fixedUpdate` runs once per *simulation step* and is what
 * hands the accumulated edges to game logic. See `capture.ts` for why.
 */
import { createActionMap, type ActionBindings, type ActionMap } from './actions';
import { createInputCapture, type InputCapture, type InputCaptureOptions } from './capture';
import type { EngineContext, EngineModule, HostContext } from '@gameable/core';
import type { InputState } from './state';

/**
 * What the module publishes as the `input` service. `init` returns it, so
 * the engine registers it under the module id and `engine.get('input')`
 * resolves to exactly this object.
 *
 * @example
 * ```ts
 * import { input, type InputService } from 'gameable/input';
 *
 * const module = input({ actions: { jump: ['Space'] } });
 * const service: InputService | null = module.service;
 * console.log(service); // null until the engine calls init()
 * ```
 */
export interface InputService {
  /** The packed state for the current frame. */
  readonly state: InputState;
  /** The action map built from `options.actions`. */
  readonly actions: ActionMap;
  /** Ask the browser for pointer lock; needs a user gesture. */
  requestPointerLock(): void;
  /** Release pointer lock if it is held. */
  exitPointerLock(): void;
  /**
   * True when the browser refused the last pointer-lock request. Show a
   * "click to play" prompt rather than assuming the mouse is captured.
   */
  readonly lockDenied: boolean;
  /**
   * Publish one fixed step's worth of edges and mouse deltas into `state`.
   *
   * The module already does this from its own `fixedUpdate`, which runs at
   * `order -100` and therefore before any gameplay module. It is exposed for a
   * host that drives the loop itself and does not register the module.
   */
  consume(): void;
}

/**
 * Options for {@link input}.
 *
 * @example
 * ```ts
 * import { input, type InputOptions } from 'gameable/input';
 *
 * const options: InputOptions = { pointerLock: true, actions: { fire: ['LMB'] } };
 * console.log(input(options).id); // 'input'
 * ```
 */
export interface InputOptions extends InputCaptureOptions {
  /**
   * Element to capture from. Defaults to the renderer's canvas
   * (`ctx.renderer.domElement`), then to the global window.
   */
  target?: HTMLElement | Window;
  /** Action bindings, compiled once during `init`. */
  actions?: ActionBindings;
}

/**
 * The input module, with the service exposed directly for hosts that do not
 * go through the registry.
 *
 * @example
 * ```ts
 * import { input, type InputModule } from 'gameable/input';
 *
 * const module: InputModule = input();
 * console.log(module.id, module.order); // 'input' -100
 * ```
 */
export interface InputModule extends EngineModule {
  /** The published service, or null before `init` and after `dispose`. */
  readonly service: InputService | null;
  /**
   * Create the capture and return the service, which the engine publishes
   * under `input`. Synchronous: input needs no asynchronous setup.
   *
   * @param ctx The host context. It has no renderer by design, so the capture
   * falls back to `window` when none is present.
   *
   * @returns The service, also available as {@link InputModule.service}.
   */
  init(ctx: HostContext): InputService;
  /** Snapshot the frame. Safe before `init` and after `dispose`. */
  beginFrame(): void;
  /**
   * Hand this fixed step the edges and deltas that have accumulated since the
   * previous one. Safe before `init` and after `dispose`.
   *
   * @param dt Always `ctx.config.fixedDt`; unused.
   */
  fixedUpdate(dt: number): void;
  /** Clear this frame's published edges. Safe before `init` and after `dispose`. */
  endFrame(): void;
}

/**
 * The renderer's canvas, when the host built a context that has one.
 *
 * `HostContext` has no renderer by design: a headless host or a test hands
 * over no canvas, and the capture then falls back to `window`. Asking for a
 * canvas that is not there must not throw.
 *
 * @param ctx The engine context.
 *
 * @returns The canvas, or `undefined`.
 */
function canvasOf(ctx: HostContext): HTMLElement | undefined {
  const { renderer } = ctx as Partial<EngineContext>;
  return renderer?.domElement;
}

/** Input runs before gameplay modules, so a frame reads fresh state. */
const INPUT_ORDER = -100;

/** The module id, and the registry key its service is published under. */
const INPUT_ID = 'input';

/**
 * Create the input `EngineModule`.
 *
 * `beginFrame` folds the frame's DOM events into the capture's pending edges
 * and publishes the level state; `fixedUpdate` hands one simulation step the
 * edges and mouse deltas that have accumulated since the previous step;
 * `endFrame` clears the published edges. All three delegate to the capture and
 * allocate nothing.
 *
 * @param options See {@link InputOptions}.
 *
 * @returns The module; register it with the engine.
 *
 * @example
 * ```ts
 * import { input } from 'gameable/input';
 *
 * const module = input({
 *   pointerLock: true,
 *   actions: { fire: ['LMB', 'GamepadRT'], move: { axis2: ['A', 'D', 'S', 'W'] } },
 * });
 *
 * console.log(module.id); // 'input'
 * ```
 */
export function input(options: InputOptions = {}): InputModule {
  const { target, actions: bindings = {}, ...captureOptions } = options;
  let capture: InputCapture | null = null;
  let service: InputService | null = null;

  return {
    id: INPUT_ID,
    order: INPUT_ORDER,

    get service(): InputService | null {
      return service;
    },

    init(ctx: HostContext): InputService {
      const element = target ?? canvasOf(ctx) ?? globalThis.window;
      const live = createInputCapture(element, captureOptions);
      capture = live;
      service = {
        state: live.state,
        actions: createActionMap(bindings, live.state),
        requestPointerLock: () => {
          live.requestPointerLock();
        },
        exitPointerLock: () => {
          live.exitPointerLock();
        },
        get lockDenied(): boolean {
          return live.lockDenied;
        },
        consume: () => {
          live.consume();
        },
      };
      // Returning the service publishes it under `id`, so it is reachable as
      // `engine.get('input')`.
      return service;
    },

    beginFrame(): void {
      capture?.beginFrame();
    },

    fixedUpdate(): void {
      // Order -100 puts this before physics (0) and gameplay (100), so every
      // module that reads `pressed`/`released` this step sees the edges that
      // accumulated since the previous step — however many frames were drawn
      // in between, including none.
      capture?.consume();
    },

    endFrame(): void {
      capture?.endFrame();
    },

    dispose(): void {
      capture?.dispose();
      capture = null;
      service = null;
    },
  };
}
