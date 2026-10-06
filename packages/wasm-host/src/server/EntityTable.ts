/**
 * `EntityTable` — the records, the body table and the tick log: the part of
 * the world record that says which entities exist and which body drives each.
 *
 * `WorldRecord` extends it with the setters the guest's commands call.
 */
import type { AssetId, BodyId, Entity, Quat, Shape, Vec3 } from '@gameable/sdk';
import { MAX_PLAYER_ID } from '@gameable/sdk/wire';

import { BodyTable } from './BodyTable';
import { createEntityRecord, snapshotEntity, type SpawnFlags } from './EntityRecord';
import { TickLog } from './TickLog';
import type { EntityRecord, EntitySnapshot, WarnSink, WorldSnapshot } from './types';

/**
 * Options accepted by the {@link WorldRecord} constructor.
 *
 * @example
 * ```ts
 * const world = new WorldRecord({ maxBodies: 16384, warn: log.warn });
 * ```
 */
export interface WorldRecordOptions {
  /** Body ids the body table holds before it first grows. Defaults to 4096. */
  maxBodies?: number;
  /** Where the one-time warnings go. Defaults to `console.warn`. */
  warn?: WarnSink;
}

/**
 * Every live entity, which body drives it, and what was spawned and despawned
 * this tick. The base of `WorldRecord`.
 *
 * @example
 * ```ts
 * import { WorldRecord } from 'gameable/host/server';
 *
 * const table: EntityTable = new WorldRecord();
 * table.advance();
 * console.log(table.frame, table.spawned.length);
 * ```
 */
export class EntityTable {
  protected readonly records = new Map<Entity, EntityRecord>();
  private readonly bodies: BodyTable;
  private readonly log = new TickLog();
  protected tick = 0;
  /** `playerEntities[player]`: the entity each player controls, or 0. */
  private readonly playerEntities: number[] = [];

  /** @param options Body table size and warning sink. */
  constructor(options: WorldRecordOptions = {}) {
    const warn =
      options.warn ??
      ((message: string): void => {
        console.warn(message);
      });
    this.bodies = new BodyTable(options.maxBodies ?? 4096, warn);
  }

  /** @returns Every live entity, keyed by id, in spawn order. */
  get entities(): ReadonlyMap<Entity, EntityRecord> {
    return this.records;
  }

  /** @returns The current tick; a change made now stamps this as its `serial`. */
  get frame(): number {
    return this.tick;
  }

  /**
   * @returns The entities spawned this tick and still live, in spawn order.
   *   The same array every tick, emptied by `advance()`.
   */
  get spawned(): readonly Entity[] {
    return this.log.spawned;
  }

  /**
   * @returns The entities that existed before this tick and were despawned
   *   during it. A respawn is in both lists; one born and gone this tick is in
   *   neither. The same array every tick, emptied by `advance()`.
   */
  get despawned(): readonly Entity[] {
    return this.log.despawned;
  }

  /** Start the next tick: bump the frame and empty the spawn and despawn logs. */
  advance(): void {
    this.tick += 1;
    this.log.rewind();
  }

  /**
   * Create an entity's record, replacing any record it already had.
   *
   * @param entity Entity id.
   * @param asset Renderable asset, or `undefined`.
   * @param position Initial position.
   * @param rotation Initial rotation.
   * @param scale Initial scale.
   * @param flags Parent, visibility and debug name, as `spawn-entity` carries them.
   * @returns The new record.
   */
  spawn(
    entity: Entity,
    asset: AssetId | undefined,
    position: Vec3,
    rotation: Quat,
    scale: Vec3,
    flags: SpawnFlags,
  ): EntityRecord {
    this.despawn(entity);
    const record = createEntityRecord(entity, asset, position, rotation, scale, flags, this.tick);
    this.records.set(entity, record);
    this.log.spawn(entity);
    return record;
  }

  /**
   * Destroy an entity's record and forget the body that drove it.
   *
   * @param entity Entity id.
   * @returns True when the entity existed.
   */
  despawn(entity: Entity): boolean {
    const record = this.records.get(entity);
    if (record === undefined) return false;
    if (record.body !== undefined) this.bodies.set(record.body, 0);
    this.records.delete(entity);
    const players = this.playerEntities;
    for (let i = 0; i < players.length; i += 1) if (players[i] === entity) players[i] = 0;
    this.log.despawn(entity, record.spawnedAt === this.tick);
    return true;
  }

  /**
   * An entity's record.
   *
   * @param entity Entity id.
   * @returns The record, or `undefined` when the entity is not live.
   */
  get(entity: Entity): EntityRecord | undefined {
    return this.records.get(entity);
  }

  /**
   * Stamp a record's pose (lanes, teleport) as changed this tick.
   *
   * @param record The record.
   */
  touchPose(record: EntityRecord): void {
    record.poseSerial = this.tick;
    record.serial = this.tick;
  }

  /**
   * Stamp a record's structure (asset, parent, visibility) as changed this tick.
   *
   * @param record The record.
   */
  touchState(record: EntityRecord): void {
    record.stateSerial = this.tick;
    record.serial = this.tick;
  }

  /**
   * Stamp a record's animation as changed this tick.
   *
   * @param record The record.
   */
  touchAnim(record: EntityRecord): void {
    record.animSerial = this.tick;
    record.serial = this.tick;
  }

  /**
   * Stamp a record's character state as changed this tick.
   *
   * @param record The record.
   */
  touchCharacter(record: EntityRecord): void {
    record.characterSerial = this.tick;
    record.serial = this.tick;
  }

  /**
   * Stamp a record as changed this tick because its visual state did; the
   * visual entries stamp their own ticks.
   *
   * @param record The record.
   */
  touchVisual(record: EntityRecord): void {
    record.serial = this.tick;
  }

  /**
   * Record that a body drives an entity.
   *
   * The body is mapped even when the entity has no record yet, as the page
   * does, so a raycast hit on it still names the entity. No change tick
   * moves: clients never see body ids.
   *
   * @param body Body id.
   * @param entity Entity id.
   * @param shape The guest's `add-body` shape, copied onto the record so a
   *   later introduction can draw the same placeholder on a client with no
   *   physics module. `undefined` leaves any shape the record already has.
   * @returns False when the id is at or past `maxBodies`: nothing was mapped,
   *   and the body must not be created.
   */
  attachBody(body: BodyId, entity: Entity, shape?: Shape): boolean {
    if (!this.bodies.set(body, entity)) return false;
    const record = this.records.get(entity);
    if (record !== undefined) {
      record.body = body;
      if (shape !== undefined) {
        const half = shape.halfExtents;
        record.bodyShape = { kind: shape.kind, halfExtents: { x: half.x, y: half.y, z: half.z } };
      }
    }
    return true;
  }

  /**
   * Forget a body, and clear it (and its shape) from the entity it drove.
   *
   * @param body Body id.
   */
  detachBody(body: BodyId): void {
    const record = this.records.get(this.bodies.entityOf(body));
    this.bodies.set(body, 0);
    if (record?.body === body) {
      record.body = undefined;
      record.bodyShape = null;
    }
  }

  /**
   * Record which entity a player controls (`set-player-entity`). A despawn of
   * that entity clears it.
   *
   * @param player The player id.
   * @param entity The entity, or 0 for none.
   */
  setPlayerEntity(player: number, entity: Entity): void {
    if (player < 0 || player > MAX_PLAYER_ID) return;
    const players = this.playerEntities;
    while (players.length <= player) players.push(0);
    players[player] = entity;
  }

  /**
   * @param player A player id.
   * @returns The entity that player controls, or 0.
   */
  entityOfPlayer(player: number): Entity {
    return this.playerEntities[player] ?? 0;
  }

  /**
   * The entity a body drives.
   *
   * @param body Body id.
   * @returns The entity, or 0 for an unknown body.
   */
  entityOfBody(body: BodyId): Entity {
    return this.bodies.entityOf(body);
  }

  /**
   * The whole world as plain JSON-safe data that aliases nothing live.
   *
   * @returns The snapshot. Allocates; call it for a welcome, never per tick.
   */
  snapshot(): WorldSnapshot {
    const entities: EntitySnapshot[] = [];
    for (const record of this.records.values()) entities.push(snapshotEntity(record));
    return { frame: this.tick, entities };
  }

  /** Forget every entity, body and this tick's log. */
  dispose(): void {
    this.playerEntities.length = 0;
    this.records.clear();
    this.bodies.clear();
    this.log.rewind();
  }
}
