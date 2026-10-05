/**
 * `EntityRecord` construction and copying: the one place a record is made
 * (at spawn) and the one place it is turned into plain JSON (a welcome).
 */
import type { AssetId, Entity, Quat, Vec3 } from '@gameable/sdk';

import type { EntityRecord, EntitySnapshot } from './types';
import { VisualState } from './VisualState';

/**
 * What `spawn-entity` says besides the transform.
 *
 * @example
 * ```ts
 * world.spawn(5, 7, at, identity, unit, { parent: 2, visible: true, name: 'crate' } satisfies SpawnFlags);
 * ```
 */
export interface SpawnFlags {
  /** Parent entity, or `undefined` at the root. */
  parent?: Entity;
  /** Initial visibility. */
  visible: boolean;
  /** Debug name. */
  name?: string;
}

/**
 * Make a record, and every sub-record it will ever need but the lazy ones
 * (`anim`, `character`, visual entries).
 *
 * @param entity Entity id.
 * @param asset Renderable asset, or `undefined`.
 * @param position Initial position.
 * @param rotation Initial rotation.
 * @param scale Initial scale.
 * @param flags Parent, visibility and debug name.
 * @param tick The current tick: every change tick and `spawnedAt`.
 * @returns The new record.
 */
export function createEntityRecord(
  entity: Entity,
  asset: AssetId | undefined,
  position: Vec3,
  rotation: Quat,
  scale: Vec3,
  flags: SpawnFlags,
  tick: number,
): EntityRecord {
  return {
    entity,
    localOnly: false,
    asset,
    parent: flags.parent,
    visible: flags.visible,
    name: flags.name,
    position: Float32Array.of(position.x, position.y, position.z),
    rotation: Float32Array.of(rotation.x, rotation.y, rotation.z, rotation.w),
    scale: Float32Array.of(scale.x, scale.y, scale.z),
    anim: null,
    character: null,
    body: undefined,
    visual: new VisualState(entity),
    serial: tick,
    poseSerial: tick,
    stateSerial: tick,
    animSerial: tick,
    characterSerial: tick,
    spawnedAt: tick,
    teleportedAt: -1,
    authoredAt: -1,
  };
}

/**
 * @param record A live record.
 * @returns It as plain JSON-safe data that aliases nothing live. Allocates.
 */
export function snapshotEntity(record: EntityRecord): EntitySnapshot {
  return {
    entity: record.entity,
    asset: record.asset,
    parent: record.parent,
    visible: record.visible,
    name: record.name,
    position: Array.from(record.position),
    rotation: Array.from(record.rotation),
    scale: Array.from(record.scale),
    anim: record.anim === null ? null : { ...record.anim },
    character:
      record.character === null
        ? null
        : { ...record.character, velocity: { ...record.character.velocity } },
    body: record.body,
    visual: record.visual.snapshot(),
    serial: record.serial,
  };
}
