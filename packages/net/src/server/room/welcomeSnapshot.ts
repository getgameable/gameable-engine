/**
 * The `welcome` snapshot's JSON: the relevant part of the world record, in
 * the order a client can apply it.
 */
import type { CameraState } from '@gameable/sdk';
import type { EntityRecord, EntitySnapshot, WorldRecord } from '@gameable/wasm-host/server';

/**
 * What a client receives as `welcome.snapshot`.
 *
 * @example
 * ```ts
 * import type { WelcomeSnapshot } from 'gameable/net/server';
 *
 * const empty: WelcomeSnapshot = { frame: 0, entities: [] };
 * ```
 */
export interface WelcomeSnapshot {
  /** The authority's tick. */
  frame: number;
  /** The entities relevant to the player, every parent before its children. */
  entities: EntitySnapshot[];
  /** The player's own camera, when the guest set one. */
  camera?: CameraState;
  /** The player's own HUD JSON, when the guest set one. */
  hud?: string;
}

/**
 * Build the snapshot JSON from `world.snapshot()`, keeping the entities in
 * `order` and in that order; a parent outside `order` is not named. Nesting stays at most 10 deep (the world's own
 * snapshot is at most 8), well under the protocol's 32.
 *
 * @param world The world record.
 * @param order The relevant records, parents first.
 * @param camera The player's camera, if any.
 * @param hud The player's HUD, if any.
 * @returns The JSON text.
 */
export function welcomeSnapshot(
  world: WorldRecord,
  order: readonly EntityRecord[],
  camera: CameraState | undefined,
  hud: string | undefined,
): string {
  const all = world.snapshot();
  const byId = new Map<number, EntitySnapshot>();
  for (const entity of all.entities) byId.set(entity.entity, entity);
  const entities: EntitySnapshot[] = [];
  const included = new Set<number>();
  for (const record of order) {
    const entity = byId.get(record.entity);
    if (entity === undefined) continue;
    // A parent the player may not see is not named: the child sits at the root for them.
    if (entity.parent !== undefined && !included.has(entity.parent)) entity.parent = undefined;
    entities.push(entity);
    included.add(entity.entity);
  }
  const out: WelcomeSnapshot = { frame: all.frame, entities };
  if (camera !== undefined) out.camera = camera;
  if (hud !== undefined) out.hud = hud;
  return JSON.stringify(out);
}
