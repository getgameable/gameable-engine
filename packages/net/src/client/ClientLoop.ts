/**
 * `ClientLoop` — the `game` module on a multiplayer page.
 *
 * It replaces the host loop there. Each fixed step it opens the step on the
 * adapter, applies what the authority sent (a welcome's world, commands,
 * rows), sends this step's input up (one INPUT frame per fixed step, never
 * before the welcome), and ticks the client-role guest, if there is one, with
 * the authority's messages as `message` events. It never steps or reads
 * physics, the authority's, unless `predict` is on: then the page's own
 * character body is simulated here too (`Predictor`).
 */
import type { HostContext } from '@gameable/core';
import {
  DEFAULT_MAX_ENTITIES,
  type FrameOutput,
  type HostFrameInput,
  type PlayerInput,
} from '@gameable/sdk';
import { copyInputState, GuestLoop, type LoopEngine, type Sandbox } from '@gameable/wasm-host';

import type { ClientLoopAdapter } from './ClientLoopAdapter.js';
import type { ClientLoopOptions } from './ClientLoopOptions.js';
import { applyGuestOutput } from './guestOutput.js';
import { LocalIds } from './LocalIds.js';
import { LocalLane } from './LocalLane.js';
import type { NetService } from './NetService.js';
import { Predictor } from './Predictor.js';
import { ReplicaWriter } from './ReplicaWriter.js';

export type { ClientLoopOptions } from './ClientLoopOptions.js';

/** The input module's service, as far as this loop reads it. */
interface InputLike {
  readonly state: Parameters<typeof copyInputState>[0];
  consume?(): void;
}

/** The client loop. Construct it through {@link createClientLoop}. */
export class ClientLoop extends GuestLoop<LoopEngine, ClientLoopAdapter, Sandbox | null> {
  private readonly replica: ReplicaWriter;
  private readonly ids: LocalIds;
  private readonly lane: LocalLane;
  private input: InputLike | null = null;
  private ownsInputConsume = false;
  private fixedHz = 60;
  private guestStarted = false;
  private seq = 0;
  private predictor: Predictor | null = null;
  private offPredict: (() => void) | null = null;

  /**
   * @param engine The page's engine (or a headless one in a test).
   * @param adapter Where the authority's world is drawn.
   * @param net The room.
   * @param sandbox The client-role guest, or null for a pure replica.
   * @param options Seed, viewport and the death callback.
   */
  constructor(
    engine: LoopEngine,
    adapter: ClientLoopAdapter,
    private readonly net: NetService,
    sandbox: Sandbox | null,
    private readonly options: ClientLoopOptions = {},
  ) {
    super(engine, sandbox, adapter, options);
    const entityBase = options.entityBase ?? DEFAULT_MAX_ENTITIES;
    this.replica = new ReplicaWriter(adapter, net, entityBase);
    this.ids = new LocalIds(entityBase);
    this.lane = new LocalLane(this.args.inputState);
  }

  /**
   * Find the input service; physics only to predict, else it is the authority's.
   *
   * @param ctx The engine context.
   * @throws {Error} When `predict` is on and the page registered no physics module.
   */
  override init(ctx: HostContext): void {
    const predict = this.options.predict === true;
    if (predict && this.engine.modules.tryGet('physics') === undefined) {
      throw new Error(
        'gameable: predict needs the physics module on the page (features.multiplayer.predict)',
      );
    }
    super.init(ctx);
    if (!predict || this.physics === null) {
      this.physics = null;
      return;
    }
    this.offPredict?.();
    this.predictor = new Predictor(this.adapter, this.net, this.physics, 1 / ctx.config.fixedHz);
    this.offPredict = this.predictor.listen(this.engine.events, this.replica);
  }

  /** Stop predicting, then what every loop does. */
  override dispose(): void {
    this.offPredict?.();
    this.offPredict = null;
    super.dispose();
  }

  /** @param dt The fixed step, in seconds. */
  override fixedUpdate(dt: number): void {
    // Nothing to show and no seat to send for until the welcome.
    if (this.dead || this.net.welcomes === 0) return;
    if (!this.guestStarted && !this.startGuest()) return;
    super.fixedUpdate(dt);
  }

  /**
   * @param dt Wall-clock seconds since the last frame.
   * @param alpha Interpolation factor.
   */
  update(dt: number, alpha: number): void {
    this.adapter.update?.(dt, alpha);
  }

  protected initGuest(ctx: HostContext): void {
    this.fixedHz = ctx.config.fixedHz;
    this.replica.motion.configure(this.fixedHz, this.net.sendHz);
    this.input = (this.engine.modules.tryGet('input') as InputLike | undefined) ?? null;
    this.ownsInputConsume =
      typeof this.input?.consume === 'function' &&
      !this.engine.modules.fixedUpdateHooks.some((module) => module.id === 'input');
    // Join now, not when the `net` module inits: the page attaches this loop
    // after its level, characters and sandbox have loaded, so a slow load is
    // not an idle seat, and a boot that fails before here takes no seat.
    this.net.start();
  }

  /** Open the step, then apply what the authority sent: after `beginFixedStep`, never before. */
  protected beginStep(): void {
    this.adapter.beginFixedStep();
    const predictor = this.predictor;
    try {
      this.replica.motion.own = predictor?.ownEntity ?? 0;
      if (this.replica.apply()) {
        this.seq = 0; // a new welcome: the seat's input starts again at 1
        predictor?.reset();
      }
      // A snap moved the body: this step's guest reads where it is now.
      if (predictor?.reconcile() === true && this.physics !== null) this.bodies.read(this.physics);
    } catch (error) {
      this.fail(error instanceof Error ? error : new Error(String(error)));
    }
  }

  /** Read this step's input and send it: one INPUT frame per fixed step. */
  protected readInput(): void {
    if (this.dead) return;
    const input = this.input;
    if (input !== null) {
      if (this.ownsInputConsume) input.consume?.();
      copyInputState(input.state, this.args.inputState);
    }
    this.seq += 1;
    this.net.sendInput(this.seq, this.args.inputState);
    this.predictor?.open(this.seq);
  }

  /** The authority's messages become this step's `message` events. */
  protected beforeEncode(): void {
    // The page's events about this guest's own ids, shifted back; never the authority's.
    this.ids.filterEvents(this.adapter.events);
    this.net.drainMessages(this.onMessage);
  }

  /** @returns This page's own seat: the client guest reads its input from that lane. */
  protected readPlayers(): readonly PlayerInput[] {
    return this.lane.read(this.args.inputState, this.net.localPlayer, this.seq);
  }

  /**
   * Tick the client guest and apply what a client may: its sends go up, its
   * local commands, camera and HUD show here. Without a guest, the camera is
   * the authority's.
   *
   * @param input This step's `frame-input`.
   * @returns Null: the base class's `applyOutput` is not used on a client.
   */
  protected override step(input: HostFrameInput): FrameOutput | null {
    if (this.dead) return null;
    const sandbox = this.sandbox;
    if (sandbox === null) {
      this.replica.applyCamera(undefined);
      return null;
    }
    const out = sandbox.tick(input);
    if (sandbox.dead) this.fail(sandbox.error);
    else applyGuestOutput(this.adapter, out, this.net, this.replica, this.ids, this.predictor);
    return null;
  }

  /**
   * @param body A body id from a contact.
   * @returns The client guest's entity for its predicted body; 0 for any other.
   */
  protected entityOfBody(body: number): number {
    return this.predictor?.entityOf(body) ?? 0;
  }

  /** @param error Why the loop died. */
  protected onDead(error: Error | null): void {
    if (this.options.onDead) {
      this.options.onDead(error);
      return;
    }
    console.error(`gameable: the client loop died: ${error?.message ?? 'unknown error'}`);
  }

  /** @returns False when the guest failed to start (the loop is dead). */
  private startGuest(): boolean {
    this.guestStarted = true;
    const sandbox = this.sandbox;
    if (sandbox === null) return true;
    const net = {
      role: 'client',
      localPlayer: this.net.localPlayer,
      maxPlayers: this.net.maxPlayers,
    };
    try {
      sandbox.init({
        seed: GuestLoop.runSeed(this.options.seed),
        fixedHz: this.fixedHz,
        viewportWidth: this.options.viewport?.width ?? 0,
        viewportHeight: this.options.viewport?.height ?? 0,
        devMode: this.options.devMode ?? true,
        options: JSON.stringify({ net }),
      });
    } catch (error) {
      this.fail(error instanceof Error ? error : new Error(String(error)));
      return false;
    }
    return true;
  }

  /**
   * One authority message as a `message` event, bound once so a drain allocates no closure.
   *
   * @param from The sender (`AUTHORITY_SENDER`).
   * @param name The message name.
   * @param payload Its JSON.
   */
  private readonly onMessage = (from: number, name: string, payload: string): void => {
    this.adapter.events.push({ tag: 'message', val: { player: from, name, payload } });
  };

  /**
   * Latch dead and report why, once. The base class reports only a trapped
   * sandbox; this loop has more ways to die, and may have no sandbox at all.
   *
   * @param error Why.
   */
  private fail(error: Error | null): void {
    if (this.dead) return;
    this.dead = true;
    this.onDead(error);
  }
}

/**
 * The `game` module for a multiplayer page: the authority's world on the
 * adapter, this page's input up to the room, and the client-role guest.
 *
 * @param engine The page's engine.
 * @param adapter Where the world is drawn (the page's `EngineAdapterHandle`).
 * @param net The `net` service.
 * @param sandbox The client-role guest, or null to only show the authority's world.
 * @param options Seed, viewport and the death callback.
 * @returns The module; attach it to the page's game slot.
 *
 * @example
 * ```ts
 * import { createClientLoop } from 'gameable/net/client';
 * import { createEngineAdapter } from 'gameable/host';
 *
 * const adapter = createEngineAdapter(engine, { modules });
 * await slot.attach(createClientLoop(engine, adapter, engine.get('net'), sandbox, { seed: 7 }), engine.ctx); // joins the room
 * ```
 */
export function createClientLoop(
  engine: LoopEngine,
  adapter: ClientLoopAdapter,
  net: NetService,
  sandbox: Sandbox | null,
  options?: ClientLoopOptions,
): ClientLoop {
  return new ClientLoop(engine, adapter, net, sandbox, options);
}
