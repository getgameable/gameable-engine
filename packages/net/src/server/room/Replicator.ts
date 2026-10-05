/**
 * `Replicator` — state-based replication: each player's view of the world
 * record, brought up to date once per simulation step.
 *
 * For each player it keeps what they were told (`KnownEntities`) and the
 * tick they were told it at, and each step compares the live records with
 * that (`ViewDiff`): an entity the player does not know and may see is
 * introduced (full state, parents first); one that is gone, respawned or out
 * of range is despawned; for the rest, each part whose change tick is newer
 * than the player's (`stateSerial`, `animSerial`, `characterSerial`, each
 * visual entry's `serial`) becomes its command. Then the step's one-shots for
 * entities the player knows (or no entity), the player's own camera and HUD
 * when they changed, and the messages addressed to them or to everyone.
 * Rows are the view's own business: `PlayerView.takeRows`.
 *
 * Call {@link Replicator.collect} once per simulation step, after the
 * guest's output is applied and the physics rows are written, and before the
 * next `beginTick()`: the adapter's one-shots and sends live for one step.
 */
import type { PerPlayerOutput, ServerAdapter } from '@gameable/wasm-host/server';

import { BodyStates, type BodyReader } from './BodyStates.js';
import { copyCamera, copyTransient, sameCamera, transientEntity } from './oneShotCommands.js';
import { PlayerView } from './PlayerView.js';
import { Relevance } from './Relevance.js';
import { isReservedMessage } from './roomPhase.js';
import { ViewDiff } from './ViewDiff.js';
import { welcomeSnapshot } from './welcomeSnapshot.js';

/**
 * What {@link createReplicator} takes. Row cadence is not here: the room
 * decides when to take rows, and serials make any cadence correct.
 *
 * @example
 * ```ts
 * import type { ReplicatorOptions } from 'gameable/net/server';
 *
 * const options: ReplicatorOptions = { cullDistance: 40 };
 * ```
 */
export interface ReplicatorOptions {
  /**
   * Metres from a player's own entity beyond which an entity (judged by its
   * root ancestor) is not replicated to them. Default: none, everything is
   * relevant. A player with no entity bound yet sees everything.
   */
  cullDistance?: number;
}

/**
 * Per-player views over one server adapter's world.
 *
 * @example
 * ```ts
 * import { applyOutput } from 'gameable/host/server';
 * import { Replicator } from 'gameable/net/server';
 *
 * const replicator = new Replicator(adapter);
 * replicator.add(1);
 * adapter.beginTick();
 * applyOutput(adapter, output);
 * replicator.collect();
 * const view = replicator.viewFor(1); // view.commands: the spawns of this step
 * ```
 */
export class Replicator {
  private readonly views = new Map<number, PlayerView>();
  /** The same views as a list, so a step walks them without an iterator. */
  private readonly list: PlayerView[] = [];
  private readonly relevance: Relevance;
  private readonly diff: ViewDiff;
  private readonly bodies: BodyStates;

  /**
   * @param adapter The server adapter whose world is replicated.
   * @param options Relevancy.
   * @param physics The room's physics world, read after a step for each
   *   player's own body (their rows' trailer). Without it no trailer is sent.
   */
  constructor(
    private readonly adapter: ServerAdapter,
    options: ReplicatorOptions = {},
    physics: BodyReader | null = null,
  ) {
    this.relevance = new Relevance(adapter.world, options.cullDistance);
    this.diff = new ViewDiff(adapter.world, this.relevance);
    this.bodies = new BodyStates(physics);
  }

  /**
   * Start a view for a player. The first collect introduces everything they
   * may see, unless a welcome snapshot is taken first.
   *
   * @param player The player id.
   * @returns The view.
   */
  add(player: number): PlayerView {
    const view = new PlayerView(player);
    view.bodies = this.bodies;
    view.lastSentTick = -1;
    view.lastRowsTick = -1;
    this.remove(player);
    this.views.set(player, view);
    this.list.push(view);
    return view;
  }

  /** @param player A player whose view is no longer needed. */
  remove(player: number): void {
    const view = this.views.get(player);
    if (view === undefined) return;
    this.views.delete(player);
    this.list.splice(this.list.indexOf(view), 1);
  }

  /**
   * @param player A player id.
   * @returns The entity the guest says that player controls
   *   (`set-player-entity`), or 0: none, or it was despawned.
   */
  entityOf(player: number): number {
    return this.adapter.world.entityOfPlayer(player);
  }

  /** Bring every view up to date with the step just applied. */
  collect(): void {
    this.bodies.stale = true; // the step moved them; the next trailer reads again
    const frame = this.adapter.world.frame;
    const list = this.list;
    for (let i = 0; i < list.length; i += 1) {
      const view = list[i];
      this.relevance.aim(view, this.adapter.perPlayer.at(view.player));
      this.diff.step(view);
      this.oneShots(view);
      this.playerOutput(view);
      view.collected(frame);
    }
  }

  /**
   * Take what a player has been sent since their last take.
   *
   * @param player A player with a view.
   * @returns The view; its commands and messages cover every step since the last take.
   * @throws {RangeError} When the player has no view.
   */
  viewFor(player: number): PlayerView {
    return this.view(player).take(this.adapter.world.frame, this.entityOf(player));
  }

  /**
   * The welcome snapshot for a player, and their view reset to it.
   *
   * @param player A player with a view.
   * @returns JSON `{ frame, entities, camera?, hud? }` (a `WelcomeSnapshot`):
   *   the entities relevant to the player, parents before children.
   * @throws {RangeError} When the player has no view.
   */
  snapshotFor(player: number): string {
    const view = this.view(player);
    const world = this.adapter.world;
    view.reset(world.frame);
    this.relevance.aim(view, this.adapter.perPlayer.at(player));
    const order = this.diff.knowAll(view);
    const out: PerPlayerOutput | undefined = this.adapter.perPlayer.at(player);
    if (out?.camera !== undefined) view.lastCamera = copyCamera(out.camera);
    view.lastHud = out?.hud;
    return welcomeSnapshot(world, order, view.lastCamera, view.lastHud);
  }

  /** Forget every view. */
  dispose(): void {
    this.views.clear();
    this.list.length = 0;
  }

  /**
   * @param player A player id.
   * @returns Their view.
   * @throws {RangeError} When the player has none.
   */
  private view(player: number): PlayerView {
    const view = this.views.get(player);
    if (view === undefined)
      throw new RangeError(`Replicator: no view for player ${String(player)}`);
    return view;
  }

  /**
   * This step's one-shots, for entities the player knows or for none.
   *
   * @param view The player's view.
   */
  private oneShots(view: PlayerView): void {
    const transient = this.adapter.transient;
    for (let i = 0; i < transient.length; i += 1) {
      const command = transient[i];
      const entity = transientEntity(command);
      if (entity !== undefined && view.known.get(entity) === undefined) continue;
      const copy = copyTransient(command);
      if (copy !== null) view.pending.push(copy);
    }
  }

  /**
   * The player's own camera and HUD when they changed, and their messages:
   * this step's sends addressed to them or to everyone, in emission order.
   *
   * @param view The player's view.
   */
  private playerOutput(view: PlayerView): void {
    const player = view.player;
    const out: PerPlayerOutput | undefined = this.adapter.perPlayer.at(player);
    if (out !== undefined) {
      const camera = out.camera;
      if (camera !== undefined && !sameCamera(view.lastCamera, camera)) {
        const copy = copyCamera(camera);
        view.lastCamera = copy;
        view.pending.push({ tag: 'set-player-camera', val: { player, camera: copy } });
      }
      const hud = out.hud;
      if (hud !== undefined && hud !== view.lastHud) {
        view.lastHud = hud;
        view.pending.push({ tag: 'set-player-hud', val: { player, hud } });
      }
    }
    // One ordered log: broadcasts and private sends interleave as the guest emitted them.
    const sends = this.adapter.sends;
    for (let i = 0; i < sends.length; i += 1) {
      const send = sends[i];
      if (isReservedMessage(send.name)) continue; // the engine's own (`aos:phase`): the room reads it
      if (send.to === undefined || send.to === player) view.message(send.name, send.payload);
    }
  }
}

/**
 * Make a replicator over a server adapter.
 *
 * @param adapter The server adapter whose world is replicated.
 * @param options Relevancy.
 * @returns The replicator.
 *
 * @example
 * ```ts
 * import { createReplicator } from 'gameable/net/server';
 *
 * const replicator = createReplicator(adapter, { cullDistance: 40 });
 * ```
 */
export function createReplicator(adapter: ServerAdapter, options?: ReplicatorOptions): Replicator {
  return new Replicator(adapter, options);
}
