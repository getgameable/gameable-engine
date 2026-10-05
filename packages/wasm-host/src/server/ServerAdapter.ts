/**
 * `ServerAdapter` — the {@link EngineAdapter} an authority runs.
 *
 * The page's `createEngineAdapter` turns `frame-output` into three.js objects;
 * this one turns it into a `WorldRecord` and forwards the body commands
 * to the Jolt world (both in the `WorldAdapter` base), and keeps the tick's
 * one-shot commands and the players' cameras and HUDs for the replicator.
 * What lasts (material parameters, expression, look-at, clip weights) goes on
 * the record; what happens once (lines, sounds, the listener, preloads) goes
 * to `transient`. What a `local-commands` entry does stays off both and off
 * the sends: it never leaves the authority (see `WorldAdapter.localScope`). It imports no three and allocates nothing per tick: records
 * are made at spawn, everything else is pooled.
 */
import type { PhysicsService } from '@gameable/physics-jolt';
import type {
  AssetId,
  AudioBus,
  CameraState,
  Command,
  Entity,
  ExchangeCmd,
  ExpressionSpace,
  GameEvent,
  MaterialValue,
  Quat,
  SendCmd,
  SoundId,
  Vec3,
} from '@gameable/sdk';

import type { EngineAdapter } from '../adapter/EngineAdapter';
import { NoDataSink } from './NoDataSink';
import { PlayerViews } from './PlayerViews';
import { TransientCommands } from './TransientCommands';
import type { DataSink, PerPlayerOutput, ServerAdapterOptions } from './types';
import { WorldAdapter } from './WorldAdapter';

/**
 * The guest's commands applied to a world record instead of a scene.
 *
 * @example
 * ```ts
 * import { applyOutput, ServerAdapter } from 'gameable/host/server';
 *
 * const adapter = new ServerAdapter(physics);
 * adapter.beginTick();
 * applyOutput(adapter, sandbox.tick(input));
 * console.log(adapter.world.entities.size, adapter.transient.length);
 * ```
 */
export class ServerAdapter extends WorldAdapter implements EngineAdapter {
  /** The authority applies `frame-output.local-commands`. */
  readonly appliesLocal = true;
  /** Host events for the guest's next tick; the server loop drains it. */
  readonly events: GameEvent[] = [];
  /** `perPlayer[id]`: what each player is shown; made when a command first names them. */
  readonly perPlayer: PerPlayerOutput[];
  /** This tick's sends with no `to`, for every player; cleared by `beginTick()`. */
  readonly broadcasts: readonly SendCmd[];
  /**
   * Every send of this tick, broadcasts and private alike, in the order the
   * guest emitted them; cleared by `beginTick()`. The replicator walks this,
   * so a player gets their messages in emission order.
   */
  readonly sends: readonly SendCmd[];

  private readonly views: PlayerViews;
  private readonly data: DataSink;
  private readonly transients = new TransientCommands();

  /**
   * @param physics The Jolt world bodies are forwarded to.
   * @param options Body table size, warning sink and data sink.
   */
  constructor(physics: PhysicsService, options: ServerAdapterOptions = {}) {
    super(physics, options);
    this.views = new PlayerViews(this.warnings);
    this.perPlayer = this.views.list;
    this.broadcasts = this.views.broadcasts;
    this.sends = this.views.log;
    this.data = options.dataSink ?? new NoDataSink(this.warnings);
  }

  /**
   * @returns This tick's one-shot commands (`say`, `play-sound`, `stop-sound`,
   *   `set-listener`, `load-asset`), as pooled copies, in the order sent.
   */
  get transient(): readonly Command[] {
    return this.transients.list;
  }

  /**
   * Start a tick: advance the frame, empty the spawn and despawn logs and
   * forget the last tick's one-shots and sends.
   */
  beginTick(): void {
    // A command that threw inside the local span left `local` set; a tick starts shared.
    this.local = false;
    this.world.advance();
    this.transients.rewind();
    this.views.rewind();
  }

  // -- persistent visual state, on the record --------------------------------

  setMaterialParam(entity: Entity, name: string, value: MaterialValue): void {
    if (this.writable(entity)) this.world.setMaterialParam(entity, name, value);
  }

  setClipWeights(
    entity: Entity,
    clips: readonly string[],
    weights: ArrayLike<number>,
    timeScale: number,
  ): void {
    if (this.writable(entity)) this.world.setClipWeights(entity, clips, weights, timeScale);
  }

  setExpression(entity: Entity, space: ExpressionSpace, weights: ArrayLike<number>): void {
    if (this.writable(entity)) this.world.setExpression(entity, space, weights);
  }

  lookAt(entity: Entity, target: Vec3 | undefined, weight: number): void {
    if (this.writable(entity)) this.world.lookAt(entity, target, weight);
  }

  // -- one-shots, copied for the replicator -----------------------------------

  say(entity: Entity, text: string, audio: AssetId | undefined, visemes: string | undefined): void {
    if (!this.local) this.transients.say(entity, text, audio, visemes);
  }

  playSound(
    sound: SoundId,
    asset: AssetId,
    entity: Entity | undefined,
    position: Vec3 | undefined,
    volume: number,
    pitch: number,
    looping: boolean,
    bus: AudioBus,
  ): void {
    if (this.local) return;
    this.transients.playSound(sound, asset, entity, position, volume, pitch, looping, bus);
  }

  stopSound(sound: SoundId, fadeMs: number): void {
    if (!this.local) this.transients.stopSound(sound, fadeMs);
  }

  setListener(position: Vec3, rotation: Quat, velocity: Vec3): void {
    if (!this.local) this.transients.setListener(position, rotation, velocity);
  }

  loadAsset(asset: AssetId, priority: number): void {
    if (!this.local) this.transients.loadAsset(asset, priority);
  }

  // -- the players' views and messages -------------------------------------------

  setCamera(camera: CameraState): void {
    this.views.setCamera(camera);
  }

  setHud(json: string | undefined): void {
    this.views.setHud(json);
  }

  setPlayerCamera(player: number, camera: CameraState): void {
    if (!this.local) this.views.setPlayerCamera(player, camera);
  }

  setPlayerHud(player: number, hud: string): void {
    if (!this.local) this.views.setPlayerHud(player, hud);
  }

  send(to: number | undefined, name: string, payload: string, reliable: boolean): void {
    if (!this.local) this.views.send(to, name, payload, reliable);
  }

  // The room's store: Task 5.2's sink, or one that warns.
  savePlayerData(player: number, data: string): void {
    this.data.savePlayer(player, data);
  }

  saveGameData(data: string): void {
    this.data.saveGame(data);
  }

  setPlayerEntity(player: number, entity: Entity): void {
    if (!this.local) this.world.setPlayerEntity(player, entity);
  }

  exchange(command: ExchangeCmd): void {
    this.data.exchange(command);
  }

  // -- page-only commands -------------------------------------------------------

  conversation(): void {
    this.warnings.warn('gameable: conversation commands are ignored on the server');
  }

  setPointerLock(): void {
    this.warnings.warn('gameable: set-pointer-lock is a page command; the server ignores it');
  }

  setTimeScale(): void {
    this.warnings.warn('gameable: set-time-scale is not supported on the server; ignored');
  }

  /** Forget every entity, body mapping and pending one-shot. The physics world is not ours. */
  dispose(): void {
    this.world.dispose();
    this.transients.rewind();
    this.events.length = 0;
  }
}
