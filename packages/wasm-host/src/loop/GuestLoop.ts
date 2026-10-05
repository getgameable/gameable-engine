/**
 * `GuestLoop` — the `game` module's shared body: the guest ticked once per
 * fixed step, its output applied to an adapter.
 *
 * The page's `HostLoop` and the authority's `ServerLoop` are subclasses; they
 * differ in where input comes from, how a step begins on their adapter, what
 * else the page queues (sounds, resizes) and how a death is reported. The tick
 * itself — encode, {@link GuestLoop.step}, the dead latch, `applyOutput` —
 * and the `physics:stepped` handling live here, once. A loop with no guest (a
 * pure replica) passes a null sandbox and overrides `step`.
 */
import type { EngineModule, HostContext } from '@gameable/core';
import type { PhysicsService } from '@gameable/physics-jolt';
import type { FrameOutput, HostFrameInput, PlayerInput } from '@gameable/sdk';

import { BodyRows } from '../adapter/BodyRows';
import { ContactReader } from '../adapter/ContactReader';
import { EventBuffer } from '../adapter/EventBuffer';
import { createInputSnapshot } from '../adapter/inputSnapshot';
import { applyOutput } from '../apply';
import { createInputEncoder, type EncodeArgs, type InputEncoder } from '../encode-input';
import type { Sandbox } from '../sandbox';
import type { GuestLoopOptions, LoopAdapter, LoopEngine } from './types';

/** The players lane of a loop that has none: a single-player page. */
const NO_PLAYERS: readonly PlayerInput[] = Object.freeze([]);

/**
 * The `game` module: one fixed step is one guest tick.
 *
 * A step runs {@link GuestLoop.beginStep}, {@link GuestLoop.readInput},
 * {@link GuestLoop.beforeEncode}, then reads contacts, drains events, reads
 * {@link GuestLoop.readPlayers}, encodes,
 * steps and applies. The first failure latches: a trapped guest is not
 * retried, the frame it returned is not applied, and
 * {@link GuestLoop.onDead} runs once.
 *
 * @example
 * ```ts
 * class MyLoop extends GuestLoop<HeadlessEngine, ServerAdapter> {
 *   protected initGuest(ctx: HostContext): void { this.sandbox.init(config); }
 *   protected beginStep(): void { this.adapter.beginTick(); }
 *   protected readInput(): void { aliasInputState(input, this.args.inputState); }
 *   protected entityOfBody(body: number): number { return this.adapter.world.entityOfBody(body); }
 *   protected onDead(error: Error | null): void { console.error(error); }
 * }
 * ```
 */
export abstract class GuestLoop<
  E extends LoopEngine,
  A extends LoopAdapter,
  S extends Sandbox | null = Sandbox,
> implements EngineModule {
  /** The module id; the slot it fills is registered under the same one. */
  readonly id = 'game';
  /** The module order. */
  readonly order: number;

  /** The `frame-input` builder; reuses one record. */
  protected readonly encoder: InputEncoder;
  /** Post-step body rows, reused; grows by doubling when the world does. */
  protected readonly bodies: BodyRows;
  /** The encoder's arguments, one object rewritten every tick. */
  protected readonly args: EncodeArgs;
  /** The physics service, looked up in `init`; null without one. */
  protected physics: PhysicsService | null = null;
  /** Fixed steps ticked so far. */
  protected frame = 0;
  /** Simulated seconds ticked so far. */
  protected elapsed = 0;
  /** True once the guest has died; latches. */
  protected dead = false;

  private readonly contacts = new ContactReader();
  private readonly eventBuffer = new EventBuffer();
  private offStepped: (() => void) | null = null;

  /**
   * @param engine The booted engine, page or headless.
   * @param sandbox The guest, or null for a loop that runs none.
   * @param adapter Where the guest's output is applied.
   * @param options Capacity and module order.
   */
  constructor(
    protected readonly engine: E,
    protected readonly sandbox: S,
    protected readonly adapter: A,
    options: GuestLoopOptions,
  ) {
    this.order = options.order ?? -50;
    const initialBodies = Math.max(1, options.maxBodies ?? 1024);
    this.encoder = createInputEncoder(initialBodies);
    this.bodies = new BodyRows(initialBodies);
    this.args = {
      frame: 0,
      dt: 0,
      elapsed: 0,
      inputState: createInputSnapshot(),
      bodies: this.bodies.rows,
      bodyCount: 0,
      contacts: undefined,
      events: undefined,
      players: NO_PLAYERS,
    };
  }

  /**
   * Look physics up, subscribe to `physics:stepped`, then the subclass's own set-up.
   *
   * @param ctx The engine context.
   */
  init(ctx: HostContext): void {
    this.physics = (this.engine.modules.tryGet('physics') as PhysicsService | undefined) ?? null;
    this.offStepped?.();
    this.offStepped = this.engine.events.on('physics:stepped', this.onPhysicsStepped);
    this.initGuest(ctx);
  }

  /**
   * Tick the guest once and apply what it sent.
   *
   * @param dt The fixed step, in seconds.
   */
  fixedUpdate(dt: number): void {
    if (this.dead) return;
    // First thing in the step, so it precedes both the guest's writes and the
    // physics rows that land after this module has returned.
    this.beginStep();
    this.readInput();
    this.beforeEncode?.();
    const args = this.args;
    args.contacts = this.contacts.read(this.physics, this.bodyEntity);
    // Double-buffered: the producers' queue is emptied into the buffer the
    // guest reads, and neither array is ever reallocated.
    args.events = this.eventBuffer.drain(this.adapter.events);
    this.elapsed += dt;
    args.frame = this.frame;
    args.dt = dt;
    args.elapsed = this.elapsed;
    args.bodies = this.bodies.rows;
    args.bodyCount = this.bodies.count;
    args.players = this.readPlayers();
    const input = this.encoder.encode(args);
    this.frame += 1;

    const out = this.step(input);
    if (out === null) return;
    // A guest that trapped inside `tick` returns the sandbox's inert frame.
    // Applying it would wipe the last live camera and HUD, so it is dropped.
    if (this.sandbox?.dead === true) {
      this.die();
      return;
    }
    applyOutput(this.adapter, out);
  }

  /** Unsubscribe, shut the guest down (when there is one) and dispose the adapter. */
  dispose(): void {
    this.offStepped?.();
    this.offStepped = null;
    this.sandbox?.shutdown();
    this.adapter.dispose();
  }

  /**
   * The subclass's part of `init`: its own services, and `sandbox.init`.
   *
   * @param ctx The engine context.
   */
  protected abstract initGuest(ctx: HostContext): void;

  /** Open the step on the adapter (`beginFixedStep`, `beginTick`). */
  protected abstract beginStep(): void;

  /** Fill `this.args.inputState` with this step's input. */
  protected abstract readInput(): void;

  /**
   * @param body A body id from a contact.
   * @returns The entity it drives.
   */
  protected abstract entityOfBody(body: number): number;

  /**
   * Report the guest's death. Runs once.
   *
   * @param error Why the sandbox died.
   */
  protected abstract onDead(error: Error | null): void;

  /** Queue anything else onto `adapter.events` before they are drained. */
  protected beforeEncode?(): void;

  /**
   * This step's `frame-input.players`. Read once per step, after
   * {@link GuestLoop.readInput}; must not allocate.
   *
   * @returns Every player in the room, ascending by id. Empty by default: a
   *   page is one player, and its input is `frame-input.input`.
   */
  protected readPlayers(): readonly PlayerInput[] {
    return NO_PLAYERS;
  }

  /**
   * Run one step of the guest. Defaults to `sandbox.tick`, and to nothing
   * without a sandbox.
   *
   * @param input This step's encoded `frame-input`.
   * @returns The frame to apply, or null for nothing to apply (the dead check
   *   and `applyOutput` are skipped).
   */
  protected step(input: HostFrameInput): FrameOutput | null {
    const sandbox = this.sandbox;
    return sandbox === null ? null : sandbox.tick(input);
  }

  /**
   * @param seed The caller's seed, if any.
   * @returns The run seed `game.init` takes; `0x5eed1234` when none was given.
   */
  protected static runSeed(seed: bigint | number | undefined): bigint {
    return typeof seed === 'bigint' ? seed : BigInt(seed ?? 0x5eed1234);
  }

  /**
   * {@link GuestLoop.entityOfBody}, bound once so a tick allocates no closure.
   *
   * @param body A body id from a contact.
   * @returns The entity it drives.
   */
  private readonly bodyEntity = (body: number): number => this.entityOfBody(body);

  /**
   * Take the rows of the step that just finished: they become the next tick's
   * `frame-input.bodies` and are written onto the entities they drive.
   */
  private readonly onPhysicsStepped = (): void => {
    const world = this.physics;
    if (world === null) return;
    this.bodies.read(world);
    this.adapter.applyBodyRows(this.bodies.rows, this.bodies.count);
  };

  /** Latch dead and report why, once. */
  private die(): void {
    if (this.dead) return;
    this.dead = true;
    this.onDead(this.sandbox?.error ?? null);
  }
}
