/**
 * The `game` module: the guest ticked once per fixed step, on the page.
 */
import type { Engine, EngineModule, HostContext } from '@gameable/core';
import type { AudioEngine } from '@gameable/audio';
import type { InputService } from '@gameable/input';

// Type-only: the adapter imports this file at runtime, never the other way.
import type { EngineAdapterHandle } from '../engineAdapter';
import { GuestLoop } from '../loop/GuestLoop';
import type { Sandbox } from '../sandbox';
import { showErrorOverlay } from './errorOverlay';
import { copyInputState } from './inputSnapshot';
import { lookup } from './lookup';
import { ResizeEvents } from './ResizeEvents';
import { SoundEvents } from './SoundEvents';

/** Options accepted by {@link createHostLoop}. */
export interface HostLoopOptions {
  /** Body rows the input encoder reserves. Defaults to 1024. */
  maxBodies?: number;
  /**
   * Module order. Defaults to `-50`: after input, **before** physics.
   *
   * That is what removes a fixed step of input latency — see
   * {@link createHostLoop}. Moving it after physics puts the latency back.
   */
  order?: number;
  /**
   * Deterministic run seed handed to `game.init`. Defaults to `0x5eed1234`.
   *
   * Fix it and a run replays; vary it and each run differs.
   */
  seed?: bigint | number;
  /** Value of `game-config.dev-mode`. Defaults to true. */
  devMode?: boolean;
  /** Extra `options` string handed to `game.init`. */
  options?: string;
  /** Call `sandbox.init` during module init. Defaults to true. */
  init?: boolean;
  /**
   * Shown when the guest dies. Defaults to a red overlay on `document.body`.
   *
   * @param error Why the sandbox died.
   */
  onDead?: (error: Error | null) => void;
}

/**
 * The page's `game` module: a {@link GuestLoop} fed by the input module, with
 * sounds and resizes queued as events, interpolation in `update`, and an
 * overlay when the guest dies. Built by {@link createHostLoop}.
 *
 * @example
 * ```ts
 * const game = new HostLoop(engine, sandbox, adapter, { seed: 1n });
 * engine.modules.register(game);
 * ```
 */
export class HostLoop extends GuestLoop<Engine, EngineAdapterHandle> {
  private readonly sounds = new SoundEvents();
  private readonly resizes = new ResizeEvents();
  private inputService: InputService | null = null;
  private audioService: AudioEngine | null = null;
  /** True when nothing else is calling `consume()` once per fixed step. */
  private ownsInputConsume = false;
  /** Unsubscribes the `engine:resize` listener; null before `init`. */
  private offResize: (() => void) | null = null;

  /**
   * @param engine The booted engine.
   * @param sandbox The guest, from `createSandbox`.
   * @param adapter The adapter from `createEngineAdapter`.
   * @param options Seed, capacity and the death handler.
   */
  constructor(
    engine: Engine,
    sandbox: Sandbox,
    adapter: EngineAdapterHandle,
    private readonly options: HostLoopOptions = {},
  ) {
    super(engine, sandbox, adapter, options);
  }

  /**
   * Hand the interpolation factor to the adapter.
   *
   * @param dt Seconds since the last frame.
   * @param alpha How far between the last two fixed steps this frame is.
   */
  update(dt: number, alpha: number): void {
    this.adapter.update(dt, alpha);
  }

  /** Unsubscribe the resize listener, then the base's teardown. */
  override dispose(): void {
    this.offResize?.();
    this.offResize = null;
    super.dispose();
  }

  /**
   * Find input and audio, subscribe to resizes, and initialise the guest.
   *
   * @param ctx The engine context.
   */
  protected initGuest(ctx: HostContext): void {
    const engine = this.engine;
    this.inputService = lookup(engine, 'input') as InputService | null;
    this.audioService = lookup(engine, 'audio') as AudioEngine | null;
    // The guest is told about a resize the same way it is told about anything
    // else the host did: an event on the next tick. Nothing else has to be
    // wired up by the application shell.
    this.offResize?.();
    this.offResize = this.resizes.subscribe(engine, this.adapter.events);
    // The input module consumes its own edges from its `fixedUpdate`. If the
    // service came from somewhere that is not a registered module with that
    // hook, nobody would ever hand a step its edges, so do it here instead.
    this.ownsInputConsume =
      typeof this.inputService?.consume === 'function' &&
      !engine.modules.fixedUpdateHooks.some((module) => module.id === 'input');
    const options = this.options;
    if (options.init === false) return;
    this.sandbox.init({
      seed: GuestLoop.runSeed(options.seed),
      fixedHz: ctx.config.fixedHz,
      viewportWidth: engine.renderer.domElement.width,
      viewportHeight: engine.renderer.domElement.height,
      devMode: options.devMode ?? true,
      options: options.options,
    });
  }

  /** Open the step on the adapter. */
  protected beginStep(): void {
    this.adapter.beginFixedStep();
  }

  /**
   * Copy the input module's frame block into the encoder's shape.
   *
   * **Edges.** `keysPressed`, `keysReleased`, the mouse edges and the mouse
   * deltas are published by the input module's own `fixedUpdate`, which runs at
   * `order -100` and therefore before this module's at `-50`. That is what
   * makes a press survive a display drawing three frames per simulation step:
   * the edge accumulates in the capture until a step takes it. When the input
   * module is not registered as a module — a host driving the loop by hand —
   * `ownsInputConsume` is set and this does the same job.
   */
  protected readInput(): void {
    const service = this.inputService;
    if (service === null) return;
    if (this.ownsInputConsume) service.consume();
    copyInputState(service.state, this.args.inputState);
  }

  /** Queue the sounds that finished since the last step as events. */
  protected beforeEncode(): void {
    this.sounds.drain(this.audioService, this.adapter.events);
  }

  /**
   * @param body A body id from a contact.
   * @returns The entity it drives.
   */
  protected entityOfBody(body: number): number {
    return this.adapter.entityOfBody(body);
  }

  /**
   * Show the guest's cause of death.
   *
   * @param error Why the sandbox died.
   */
  protected onDead(error: Error | null): void {
    if (this.options.onDead) {
      this.options.onDead(error);
      return;
    }
    showErrorOverlay(
      `the game module died: ${error?.message ?? 'unknown error'}\n` +
        'Fix the game and reload; a trapped guest cannot be restarted in place.',
    );
  }
}

/**
 * The `game` module: one fixed step is one guest tick.
 *
 * **Order `-50`: after input, before physics.** The guest therefore ticks on
 * the freshest input there is, and the `move-character`, `apply-impulse` and
 * `set-body-velocity` commands it emits are simulated by the physics step in
 * the *same* fixed step rather than the next one. That is one whole step of
 * input latency gone — the difference between a jump landing on the frame the
 * key went down and a frame later.
 *
 * The bodies the guest reads are still post-step rows, one step old: exactly
 * the state it reacted to when it emitted those commands. They arrive on the
 * `physics:stepped` event, which this module subscribes to in `init` — the
 * same handler writes each row onto the entity it drives through
 * {@link EngineAdapterHandle.applyBodyRows}, so a physics-driven object gets
 * to the screen without its transform ever crossing the wasm boundary.
 *
 * Its `update` hands the interpolation factor to the adapter, which is what
 * makes a 60 Hz simulation look smooth on a 144 Hz display.
 *
 * The first failure latches: a dead sandbox is not retried, because a trapped
 * component instance stays poisoned. The overlay says so.
 *
 * @param engine The booted engine.
 * @param sandbox The guest, from `createSandbox`.
 * @param adapter The adapter from {@link createEngineAdapter}.
 * @param options Seed, capacity and the death handler.
 * @returns A module to register with `createEngine`.
 *
 * @example
 * ```ts
 * import { createHostLoop } from 'gameable/host';
 *
 * const game = createHostLoop(engine, sandbox, adapter, { seed: 1n });
 * engine.modules.register(game); // or pass it in createEngine({ modules })
 * ```
 */
export function createHostLoop(
  engine: Engine,
  sandbox: Sandbox,
  adapter: EngineAdapterHandle,
  options: HostLoopOptions = {},
): EngineModule {
  return new HostLoop(engine, sandbox, adapter, options);
}
