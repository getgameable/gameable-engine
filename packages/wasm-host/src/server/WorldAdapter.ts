/**
 * `WorldAdapter` — the half of the server adapter that owns the world: the
 * record, the pose rows written onto it, the scene commands and the body
 * commands forwarded to Jolt.
 *
 * `ServerAdapter` extends it with what the replicator needs besides the world
 * (one-shots, views, sends) and the commands a server has no scene for.
 */
import type { PhysicsService } from '@gameable/physics-jolt';
import type { AddBodyCmd, AssetId, BodyId, Entity, Quat, Vec3 } from '@gameable/sdk';

import { PhysicsForwarder } from './PhysicsForwarder';
import { PoseWriter } from './PoseWriter';
import type { ServerAdapterOptions } from './types';
import { WarnOnce } from './WarnOnce';
import { WorldRecord, type SpawnFlags } from './WorldRecord';

/**
 * The world record and the commands that write it. The base of `ServerAdapter`.
 *
 * @example
 * ```ts
 * import { createServerAdapter } from 'gameable/host/server';
 *
 * const adapter: WorldAdapter = createServerAdapter(physics);
 * adapter.spawn(5, 7, at, identity, unit, { visible: true });
 * console.log(adapter.world.spawned); // [5]
 * ```
 */
export class WorldAdapter {
  /** Every live entity, the body table and this tick's spawn and despawn logs. */
  readonly world: WorldRecord;
  /** The one-time warning sink every part of the adapter shares. */
  protected readonly warnings: WarnOnce;

  /**
   * True while `applyOutput` applies `local-commands`. A local spawn makes a
   * `localOnly` record; a local scene, character or visual command on a shared
   * entity is not written at all: the record is what clients are shown, and a
   * local command never leaves the authority. Body commands still reach Jolt.
   */
  protected local = false;

  private readonly bodies: PhysicsForwarder;
  private readonly poses: PoseWriter;

  /**
   * @param physics The Jolt world bodies are forwarded to.
   * @param options Body table size and warning sink.
   */
  constructor(physics: PhysicsService, options: ServerAdapterOptions = {}) {
    const sink =
      options.warn ??
      ((message: string): void => {
        console.warn(message);
      });
    this.warnings = new WarnOnce(sink);
    this.world = new WorldRecord({ maxBodies: options.maxBodies, warn: sink });
    this.bodies = new PhysicsForwarder(physics, this.world, this.warnings);
    this.poses = new PoseWriter(this.world);
  }

  /**
   * Write post-step body poses onto the entities they drive. Scale is untouched,
   * and a rotation the guest wrote this tick wins, as on the page.
   *
   * @param rows Stride-15 rows from `PhysicsWorld.readBodies`.
   * @param count Rows to read; `rows` may be longer.
   */
  applyBodyRows(rows: Float32Array, count: number): void {
    this.poses.applyBodyRows(rows, count);
  }

  /**
   * @param transforms Stride-12 rows: entity, flags, position, rotation, scale.
   * @param count Rows to read.
   */
  applyTransforms(transforms: Float32Array, count: number): void {
    this.poses.applyTransforms(transforms, count);
  }

  // -- scene: the world record ------------------------------------------------

  spawn(
    entity: Entity,
    asset: AssetId | undefined,
    position: Vec3,
    rotation: Quat,
    scale: Vec3,
    flags: SpawnFlags,
  ): void {
    const record = this.world.spawn(entity, asset, position, rotation, scale, flags);
    record.localOnly = this.local;
  }

  despawn(entity: Entity): void {
    if (this.writable(entity)) this.world.despawn(entity);
  }

  setAsset(entity: Entity, asset: AssetId | undefined): void {
    if (this.writable(entity)) this.world.setAsset(entity, asset);
  }

  setParent(entity: Entity, parent: Entity | undefined): void {
    if (this.writable(entity)) this.world.setParent(entity, parent);
  }

  setAnim(entity: Entity, clip: string, looping: boolean, speed: number): void {
    if (this.writable(entity)) this.world.setAnim(entity, clip, looping, speed);
  }

  spawnCharacter(entity: Entity, bundle: AssetId): void {
    if (this.writable(entity)) this.world.setCharacter(entity, bundle);
  }

  setCharacterState(entity: Entity, state: string, velocity: Vec3, grounded: boolean): void {
    if (this.writable(entity)) this.world.setCharacterState(entity, state, grounded, velocity);
  }

  /**
   * `applyOutput` brackets the local commands with this.
   *
   * @param on True when local commands start, false when they end.
   */
  localScope(on: boolean): void {
    this.local = on;
  }

  /**
   * @param entity An entity a command names.
   * @returns False for a shared entity while local commands apply.
   */
  protected writable(entity: Entity): boolean {
    return !this.local || this.world.get(entity)?.localOnly === true;
  }

  // -- physics ----------------------------------------------------------------

  addBody(args: AddBodyCmd): void {
    this.bodies.addBody(args);
  }

  removeBody(body: BodyId): void {
    this.bodies.removeBody(body);
  }

  setBodyTransform(body: BodyId, position: Vec3, rotation: Quat, teleport: boolean): void {
    this.bodies.setBodyTransform(body, position, rotation, teleport);
  }

  setBodyVelocity(body: BodyId, linear: Vec3 | undefined, angular: Vec3 | undefined): void {
    this.bodies.setBodyVelocity(body, linear, angular);
  }

  applyImpulse(body: BodyId, impulse: Vec3, atPoint: Vec3 | undefined): void {
    this.bodies.applyImpulse(body, impulse, atPoint);
  }

  setBodyEnabled(body: BodyId, enabled: boolean): void {
    this.bodies.setBodyEnabled(body, enabled);
  }

  moveCharacter(body: BodyId, velocity: Vec3, jump: boolean, crouch: boolean, slope: number): void {
    this.bodies.moveCharacter(body, velocity, jump, crouch, slope);
  }
}
