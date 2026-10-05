/**
 * `ServerLoop` — the `game` module an authority runs: the guest ticked once
 * per fixed step on a headless engine, its output applied to a world record.
 *
 * A `GuestLoop`, as the page's `HostLoop` is, with the page taken out: no
 * input module (the {@link InputSource} replaces it), no audio, no resize, no
 * interpolation, no overlay. It imports no three.js and allocates nothing per tick beyond the
 * one `BigInt` the `u64` frame counter forces.
 */
import type { HostContext } from '@gameable/core';
import type { HeadlessEngine } from '@gameable/core/headless';
import type { PlayerInput } from '@gameable/sdk';

import { aliasInputState } from '../adapter/inputSnapshot';
import { GuestLoop } from '../loop/GuestLoop';
import type { Sandbox } from '../sandbox';
import { authorityOptions } from './authorityOptions';
import type { ServerAdapter } from './ServerAdapter';
import type { InputSource } from './types';

/**
 * Options accepted by {@link createServerLoop}.
 *
 * @example
 * ```ts
 * const options: ServerLoopOptions = { seed: 7, options: '{"mode":"duel"}' };
 * ```
 */
export interface ServerLoopOptions {
  /** Deterministic run seed handed to `game.init`. Defaults to `0x5eed1234`, as on the page. */
  seed?: bigint | number;
  /**
   * The caller's `game-config.options` JSON object. `{"net":{"role":"authority"}}`
   * is merged into it; `net.role` is always `"authority"`.
   */
  options?: string;
  /** Value of `game-config.dev-mode`. Defaults to false. */
  devMode?: boolean;
  /** Body rows the input encoder reserves before it grows. Defaults to 1024. */
  maxBodies?: number;
  /** Module order. Defaults to `-50`: before physics, as on the page. */
  order?: number;
  /**
   * Called once when the guest dies. Defaults to `console.error`.
   *
   * @param error Why the sandbox died.
   */
  onDead?: (error: Error | null) => void;
}

/**
 * The authority's `game` module: one fixed step is one guest tick.
 *
 * Order `-50`, before physics, as on the page: the guest ticks on the input of
 * this step and the body commands it emits are simulated by the physics step
 * that follows. The post-step rows arrive on `physics:stepped`, which this
 * module subscribes to in `init`; they are written onto the world record and
 * become the next tick's `frame-input.bodies`.
 *
 * The first failure latches, as on the page: a trapped guest is not retried.
 *
 * @example
 * ```ts
 * import { ServerLoop } from 'gameable/host/server';
 *
 * const loop = new ServerLoop(engine, sandbox, adapter, inputs, { seed: 7 });
 * await slot.attach(loop, engine.ctx);
 * ```
 */
export class ServerLoop extends GuestLoop<HeadlessEngine, ServerAdapter> {
  /** One `player-input` record per room slot ever used; only appended to. */
  private readonly playerPool: PlayerInput[] = [];
  /** `playerPool.slice(0, n)` by `n`, so a steady room hands over the same list. */
  private readonly playerLists: (readonly PlayerInput[] | undefined)[] = [];
  /** Whether the out-of-order warning has been given (dev mode only). */
  private warnedOrder = false;

  /**
   * @param engine The booted headless engine.
   * @param sandbox The guest, built over a `createServerHost` host.
   * @param adapter The server adapter the guest's output is applied to.
   * @param inputs Where each tick's player input comes from.
   * @param options Seed, options JSON, capacity and the death handler.
   */
  constructor(
    engine: HeadlessEngine,
    sandbox: Sandbox,
    adapter: ServerAdapter,
    private readonly inputs: InputSource,
    private readonly options: ServerLoopOptions = {},
  ) {
    super(engine, sandbox, adapter, options);
  }

  /**
   * Initialise the guest as the authority.
   *
   * @param ctx The engine context.
   * @throws {TypeError} When `options.options` is not a JSON object.
   */
  protected initGuest(ctx: HostContext): void {
    this.sandbox.init({
      seed: GuestLoop.runSeed(this.options.seed),
      fixedHz: ctx.config.fixedHz,
      viewportWidth: 0,
      viewportHeight: 0,
      devMode: this.options.devMode ?? false,
      options: authorityOptions(this.options.options),
    });
  }

  /** Open the tick on the world record. */
  protected beginStep(): void {
    this.adapter.beginTick();
  }

  /** Alias player 0's input into the encoder's arguments; nothing is copied. */
  protected readInput(): void {
    aliasInputState(this.inputs.snapshotFor(0), this.args.inputState);
  }

  /**
   * Every player in the room, from the {@link InputSource}; snapshots aliased, not copied.
   *
   * @returns The pooled players lane.
   */
  protected readPlayers(): readonly PlayerInput[] {
    const ids = this.inputs.players();
    if (this.options.devMode === true && !this.warnedOrder) this.checkOrder(ids);
    const pool = this.playerPool;
    while (pool.length < ids.length) {
      pool.push({ player: 0, seq: 0, input: this.inputs.snapshotFor(ids[pool.length]) });
    }
    for (let i = 0; i < ids.length; i += 1) {
      const record = pool[i];
      record.player = ids[i];
      record.seq = this.inputs.seqFor?.(ids[i]) ?? 0;
      record.input = this.inputs.snapshotFor(ids[i]);
    }
    let list = this.playerLists[ids.length];
    if (list === undefined) {
      list = pool.slice(0, ids.length);
      this.playerLists[ids.length] = list;
    }
    return list;
  }

  /**
   * Warn once when `InputSource.players()` is not ascending, as the WIT's
   * `frame-input.players` must be. A loop over the ids; allocates nothing.
   *
   * @param ids This tick's player ids.
   */
  private checkOrder(ids: readonly number[]): void {
    for (let i = 1; i < ids.length; i += 1) {
      if (ids[i] > ids[i - 1]) continue;
      this.warnedOrder = true;
      console.warn(
        'gameable: InputSource.players() must return ascending ids ' +
          '(frame-input.players is ascending); the server loop does not sort them',
      );
      return;
    }
  }

  /**
   * @param body A body id from a contact.
   * @returns The entity it drives, through the world record.
   */
  protected entityOfBody(body: number): number {
    return this.adapter.world.entityOfBody(body);
  }

  /**
   * Report why the guest died.
   *
   * @param error Why the sandbox died.
   */
  protected onDead(error: Error | null): void {
    if (this.options.onDead) {
      this.options.onDead(error);
      return;
    }
    console.error(
      `gameable: the game module died on the server: ${error?.message ?? 'unknown error'}; ` +
        'a trapped guest cannot be restarted in place',
    );
  }
}

/**
 * Build the authority's `game` module.
 *
 * Register it through a slot, as on the page: the slot books the module order
 * when the engine is created, and the loop, which needs the booted engine, is
 * attached afterwards.
 *
 * @param engine The booted headless engine.
 * @param sandbox The guest, built over a `createServerHost` host.
 * @param adapter The server adapter the guest's output is applied to.
 * @param inputs Where each tick's player input comes from.
 * @param options Seed, options JSON, capacity and the death handler.
 * @returns The module.
 *
 * @example
 * ```ts
 * import { createHeadlessEngine } from 'gameable/core/headless';
 * import { physics } from 'gameable/physics';
 * import {
 *   createDirectSandbox,
 *   createGameSlot,
 *   createServerAdapter,
 *   createServerHost,
 *   createServerLoop,
 * } from 'gameable/host/server';
 *
 * const slot = createGameSlot();
 * const engine = await createHeadlessEngine({ manifest, modules: [physics(), slot.module] });
 * const adapter = createServerAdapter(engine.modules.get('physics'));
 * const host = createServerHost(engine.modules.get('physics'), engine.assets, adapter, { seed: 7 });
 * const sandbox = createDirectSandbox({ mode: 'direct', game, host });
 * await slot.attach(createServerLoop(engine, sandbox, adapter, inputs, { seed: 7 }), engine.ctx);
 * engine.start();
 * ```
 */
export function createServerLoop(
  engine: HeadlessEngine,
  sandbox: Sandbox,
  adapter: ServerAdapter,
  inputs: InputSource,
  options?: ServerLoopOptions,
): ServerLoop {
  return new ServerLoop(engine, sandbox, adapter, inputs, options);
}
