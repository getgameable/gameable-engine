/**
 * `Relevance` — whether a player may see an entity: the cull distance from
 * the entity they control, judged at the entity's root ancestor.
 */
import type { EntityRecord, PerPlayerOutput, WorldRecord } from '@gameable/wasm-host/server';

import { worldPosition } from './worldPosition.js';

/** How deep a parent chain is followed before it is taken for a cycle. */
const MAX_DEPTH = 32;

/** The part of a view relevancy reads and writes: the player and their last origin. */
export interface RelevanceOrigin {
  /** The player id. */
  readonly player: number;
  /** Where the player last was. */
  readonly origin: Float32Array;
  /** Whether `origin` has ever been set. */
  hasOrigin: boolean;
}

/**
 * Distance relevancy, aimed at one player at a time.
 *
 * The origin is, in order:
 * 1. the world position of the entity the player controls (the guest's
 *    `set-player-entity`; `world.entityOfPlayer`);
 * 2. with no such entity, the player's own camera (`set-player-camera`):
 *    its `follow` target's world position, else its position. Player 0's
 *    frame camera counts only when it follows a live entity (a frame camera
 *    that follows nothing is the guest's default, not a place it chose);
 * 3. the last origin;
 * 4. none, and then everything is relevant.
 *
 * A `localOnly` record is never relevant. The player's own entity and its
 * whole parent chain always are. Anything else is relevant when its root
 * ancestor lies within the cull distance of the origin. Without a cull
 * distance, everything but local records is relevant. Allocates nothing.
 *
 * @example
 * ```ts
 * import { Relevance } from 'gameable/net/server';
 *
 * const relevance = new Relevance(adapter.world, 10);
 * relevance.aim(view, adapter.perPlayer.at(view.player));
 * relevance.relevant(record); // false when record's root is more than 10 m from the player's entity
 * ```
 */
export class Relevance {
  private readonly limit2: number;
  private ox = 0;
  private oy = 0;
  private oz = 0;
  private aimed = false;
  /** The aimed player's entity and its ancestors; `ownCount` of them are live. */
  private readonly own: number[] = new Array<number>(MAX_DEPTH + 1).fill(0);
  private ownCount = 0;

  /**
   * @param world The world record.
   * @param cullDistance Metres; undefined for no culling.
   */
  constructor(
    private readonly world: WorldRecord,
    cullDistance: number | undefined,
  ) {
    this.limit2 = cullDistance === undefined ? Number.POSITIVE_INFINITY : cullDistance * cullDistance;
  }

  /**
   * Judge from this player's point of view until the next call.
   *
   * @param view The player's view; its origin is refreshed.
   * @param output The player's per-player output (camera), if any.
   */
  aim(view: RelevanceOrigin, output?: PerPlayerOutput): void {
    const world = this.world;
    const entity = world.entityOfPlayer(view.player);
    const record = entity === 0 ? undefined : world.get(entity);
    this.ownCount = 0;
    if (record !== undefined) {
      this.keepChain(record);
      worldPosition(world, record, view.origin);
      view.hasOrigin = true;
    } else {
      this.aimAtCamera(view, output);
    }
    this.aimed = view.hasOrigin;
    this.ox = view.origin[0];
    this.oy = view.origin[1];
    this.oz = view.origin[2];
  }

  /**
   * @param record A live record, or undefined.
   * @returns Whether the player aimed at may see it.
   */
  relevant(record: EntityRecord | undefined): record is EntityRecord {
    // The authority's own entities (`local-commands` spawns) reach no player.
    if (record === undefined || record.localOnly) return false;
    if (!this.aimed || this.limit2 === Number.POSITIVE_INFINITY) return true;
    const own = this.own;
    for (let i = 0; i < this.ownCount; i += 1) if (own[i] === record.entity) return true;
    let root = record;
    for (let depth = 0; depth < MAX_DEPTH && root.parent !== undefined; depth += 1) {
      const parent = this.world.get(root.parent);
      if (parent === undefined) break;
      root = parent;
    }
    const p = root.position;
    const dx = p[0] - this.ox;
    const dy = p[1] - this.oy;
    const dz = p[2] - this.oz;
    return dx * dx + dy * dy + dz * dz <= this.limit2;
  }

  /**
   * Remember the player's entity and every ancestor: always relevant.
   *
   * @param record The player's entity.
   */
  private keepChain(record: EntityRecord): void {
    let node: EntityRecord | undefined = record;
    while (node !== undefined && this.ownCount <= MAX_DEPTH) {
      this.own[this.ownCount] = node.entity;
      this.ownCount += 1;
      node = node.parent === undefined ? undefined : this.world.get(node.parent);
    }
  }

  /**
   * No entity: aim at the player's own camera, when there is one to trust.
   *
   * @param view The player's view.
   * @param output The player's per-player output, if any.
   */
  private aimAtCamera(view: RelevanceOrigin, output: PerPlayerOutput | undefined): void {
    const camera = output?.camera;
    if (camera === undefined || output?.cameraSource === 'none') return;
    const follow = camera.follow === undefined ? undefined : this.world.get(camera.follow);
    if (follow !== undefined) {
      worldPosition(this.world, follow, view.origin);
      view.hasOrigin = true;
    } else if (output?.cameraSource === 'player') {
      view.origin[0] = camera.position.x;
      view.origin[1] = camera.position.y;
      view.origin[2] = camera.position.z;
      view.hasOrigin = true;
    }
  }
}
