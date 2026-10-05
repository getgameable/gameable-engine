/**
 * `EngineRoomGame` — the {@link RoomGame} that runs a real game: its guest
 * on a headless engine with Jolt, as the authority. Built by
 * `createEngineRoomGame`.
 */
import type { HeadlessEngine } from '@gameable/core/headless';
import type { Sandbox, ServerAdapter } from '@gameable/wasm-host/server';

import type { MutableInputSnapshot } from '../../protocol/types.js';
import type { PlayerIdentity } from '../identity/IdentityProvider.js';
import type { RoomData } from './data/index.js';
import type { PlayerView } from './PlayerView.js';
import { Replicator } from './Replicator.js';
import { RoomGame } from './RoomGame.js';
import type { RoomInputs } from './RoomInputs.js';
import { isReservedMessage, phaseIn } from './roomPhase.js';

/**
 * A room's game running on a headless engine.
 *
 * The engine has exactly two modules: Jolt and the game slot (no input, no
 * audio, no splats). The guest is told it is the authority through
 * `{"net":{"role":"authority","maxPlayers":N}}`, `N` the highest seat id
 * (`maxPlayers - 1`). `join`, `leave` and
 * `message` become `player-joined`, `player-left` and `message` events for
 * the guest's next step; `input` feeds the server loop's `InputSource`
 * ({@link RoomInputs}). After every simulation step (on `physics:stepped`,
 * once the step's output and body rows are on the world record) the
 * {@link Replicator} collects it and the step's input edges are cleared.
 * Each player's entity is what the guest says (`set-player-entity`, sent by
 * the SDK for the join spawn and every `possess`); `entityOf` reads it.
 * The guest's `ctx.net.setPhase` (the reserved `aos:phase` send) becomes
 * {@link RoomGame.phase}, for the room list; the replicator never forwards an
 * `aos:` message, and a client's own `aos:` message is dropped here.
 * With a store (the `data` option) a join first loads the player's document,
 * keyed by `identity.id` (or `seat-<id>` where the room resolves no identity),
 * and `player-joined` carries it as `{ doc, savedAt }`; the guest's saves and
 * exchanges go to the store ({@link RoomData}), flushed on leave and dispose.
 *
 * @example
 * ```ts
 * import { createEngineRoomGame, createRoom } from 'gameable/net/server';
 *
 * const game = await createEngineRoomGame({ definition, manifest, seed: 7 }); // seats from the game
 * const room = createRoom({ code: 'KQTX', game, ports, sendHz: 20 }); // seats from game.maxPlayers
 * ```
 */
export class EngineRoomGame extends RoomGame {
  /** Resolves once `dispose` has released the engine. */
  disposed: Promise<void> = Promise.resolve();
  private readonly replicator: Replicator;
  private readonly offStepped: () => void;
  /** Room clock minus engine clock, fixed at the first tick; null before it. */
  private offset: number | null = null;

  /**
   * Use {@link createEngineRoomGame}; this wires parts already built.
   *
   * @param engine The booted headless engine, the loop attached.
   * @param adapter Its server adapter.
   * @param sandbox The guest.
   * @param inputs The loop's input source.
   * @param cullDistance Replication cull distance, or undefined.
   * @param engineNow The engine clock the warm-up step left it at, in ms.
   * @param seats The seats the guest was told (`net.maxPlayers` is `seats - 1`).
   * @param data The room's documents in its store, or null for a room without one.
   */
  constructor(
    readonly engine: HeadlessEngine,
    readonly adapter: ServerAdapter,
    readonly sandbox: Sandbox,
    private readonly inputs: RoomInputs,
    cullDistance: number | undefined,
    private readonly engineNow: number,
    private readonly seats: number,
    private readonly data: RoomData | null = null,
  ) {
    super();
    // The physics world is read for each player's own body: their rows' trailer.
    this.replicator = new Replicator(adapter, { cullDistance }, engine.modules.get('physics'));
    this.offStepped = engine.events.on('physics:stepped', this.afterStep);
  }

  /** @returns The seats: the room's door and the guest's player slots agree on it. */
  get maxPlayers(): number {
    return this.seats;
  }

  /** @returns The authority's step counter. */
  get frame(): number {
    return this.adapter.world.frame;
  }

  /**
   * Run the fixed steps due by `nowMs`. The first call ties the room's clock
   * to where the warm-up step left the engine's, so the first tick does not
   * see the whole time since boot as one long frame.
   *
   * @param nowMs The room's clock.
   */
  tick(nowMs: number): void {
    this.offset ??= nowMs - this.engineNow;
    this.engine.step(nowMs - this.offset);
  }

  /**
   * @param player The new seat.
   * @param name The player's name.
   * @param data Saved data, or null; ignored when the room has a store (it loads its own).
   * @param identity Who the player is: the store key.
   */
  join(player: number, name: string, data: string | null, identity?: PlayerIdentity): void {
    this.inputs.add(player);
    this.replicator.add(player);
    if (this.data === null) {
      this.joined(player, name, data);
      return;
    }
    void this.data.join(player, identity?.id ?? `seat-${String(player)}`).then((envelope) => {
      if (envelope !== undefined) this.joined(player, name, envelope);
    });
  }

  /**
   * @param player The seat freed.
   * @param reason Why.
   */
  leave(player: number, reason: string): void {
    this.inputs.remove(player);
    this.replicator.remove(player);
    this.adapter.events.push({ tag: 'player-left', val: { player, reason } });
    void this.data?.leave(player);
  }

  /** @param player A seat the room holds: out of the guest's players list until it resumes. */
  hold(player: number): void {
    this.inputs.hold(player);
  }

  /** @param player A held seat whose player is back. */
  resume(player: number): void {
    this.inputs.resume(player);
  }

  /**
   * @param player The seat.
   * @param seq The newest input seq in it.
   * @param snapshot The room's coalesced input; read during the call.
   */
  input(player: number, seq: number, snapshot: MutableInputSnapshot): void {
    this.inputs.absorb(player, seq, snapshot);
  }

  /**
   * @param player The sender.
   * @param name The message name.
   * @param payload JSON text.
   */
  message(player: number, name: string, payload: string): void {
    if (isReservedMessage(name)) return; // the engine's own; a client cannot speak for it
    this.adapter.events.push({ tag: 'message', val: { player, name, payload } });
  }

  /**
   * @param player A seated player.
   * @returns What changed for them since their last view.
   */
  viewFor(player: number): PlayerView {
    return this.replicator.viewFor(player);
  }

  /**
   * @param player A seated player.
   * @returns Their welcome snapshot; their view restarts from it.
   */
  snapshotFor(player: number): string {
    return this.replicator.snapshotFor(player);
  }

  /**
   * @param player A seated player.
   * @returns The entity the authority spawned for them, or 0 before it has.
   */
  entityOf(player: number): number {
    return this.replicator.entityOf(player);
  }

  /**
   * @param player A seated player.
   * @returns The newest input seq a simulation step has applied for them.
   */
  ackFor(player: number): number {
    return this.inputs.appliedFor(player);
  }

  /**
   * The server loop's death handler: the guest trapped, so the game ends as
   * `crashed` (the room closes with it and tells the players).
   *
   * @param error Why the sandbox died.
   */
  guestDied(error: Error | null): void {
    console.error(`gameable: the room's guest died: ${error?.message ?? 'unknown error'}`);
    this.end('crashed');
  }

  /**
   * Release the engine, its modules (the loop shuts the guest down) and the
   * views. A module whose dispose throws is logged, never left as an unhandled
   * rejection: nobody has to await `disposed` for the process to survive it.
   */
  dispose(): void {
    this.offStepped();
    this.replicator.dispose();
    const flushed = this.data?.dispose() ?? Promise.resolve();
    const engine = this.engine.dispose().catch((error: unknown) => {
      console.error('EngineRoomGame: disposing the engine threw', error);
    });
    this.disposed = Promise.all([flushed, engine]).then(() => undefined);
  }

  /**
   * @param player The seat.
   * @param name The player's name.
   * @param data The `player-joined` data, or null.
   */
  private joined(player: number, name: string, data: string | null): void {
    this.adapter.events.push({
      tag: 'player-joined',
      val: data === null ? { player, name } : { player, name, data },
    });
  }

  private readonly afterStep = (): void => {
    const phase = phaseIn(this.adapter.sends);
    if (phase !== undefined) this.setPhase(phase);
    this.replicator.collect();
    this.inputs.consumed();
  };
}
