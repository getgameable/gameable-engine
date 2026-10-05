/**
 * `KnownEntities` — what one player has been told exists, and as what.
 */
import type { EntityRecord } from '@gameable/wasm-host/server';

/**
 * One entity as a player last heard of it. `record` is the live record it
 * was introduced from: a respawn makes a new record, so a mismatch means the
 * player's copy is stale and is despawned and introduced again.
 */
export interface KnownEntity {
  /** The entity id. */
  entity: number;
  /** The record it was introduced from. */
  record: EntityRecord;
  /** The asset handle the player was last told. */
  asset: number | undefined;
  /** The parent the player was last told. */
  parent: number | undefined;
  /** The visibility the player was last told. */
  visible: boolean;
  /** The character bundle the player was last told, or 0. */
  bundle: number;
  /** A hidden-then-shown entity whose `VISIBLE` row has not gone out yet. */
  showPending: boolean;
  /** The scale the player was last sent, three lanes. */
  readonly scale: Float32Array;
  /** Where this entry sits in `list`. */
  index: number;
}

/**
 * A pooled table of {@link KnownEntity}: a map for lookup and a dense list
 * for the per-step walks, with entries reused once forgotten.
 *
 * @example
 * ```ts
 * import { KnownEntities } from 'gameable/net/server';
 *
 * const known = new KnownEntities();
 * const entry = known.add(record);
 * known.get(record.entity) === entry; // true
 * known.remove(entry);
 * ```
 */
export class KnownEntities {
  /** Every known entity, in no particular order. */
  readonly list: KnownEntity[] = [];
  private readonly byId = new Map<number, KnownEntity>();
  private readonly free: KnownEntity[] = [];

  /** @returns How many entities the player knows. */
  get size(): number {
    return this.list.length;
  }

  /**
   * @param entity An entity id.
   * @returns What the player knows of it, if anything.
   */
  get(entity: number): KnownEntity | undefined {
    return this.byId.get(entity);
  }

  /**
   * Record that the player has just been told of `record`, as it is now.
   *
   * @param record The live record.
   * @returns The entry.
   */
  add(record: EntityRecord): KnownEntity {
    const entry = this.free.pop() ?? {
      entity: 0,
      record,
      asset: undefined,
      parent: undefined,
      visible: false,
      bundle: 0,
      showPending: false,
      scale: new Float32Array(3),
      index: 0,
    };
    entry.entity = record.entity;
    entry.record = record;
    entry.asset = record.asset;
    entry.parent = record.parent;
    entry.visible = record.visible;
    entry.bundle = record.character?.bundle ?? 0;
    entry.showPending = false;
    entry.scale.set(record.scale);
    entry.index = this.list.length;
    this.list.push(entry);
    this.byId.set(entry.entity, entry);
    return entry;
  }

  /**
   * Forget one entity (swap-remove).
   *
   * @param entry An entry from this table.
   */
  remove(entry: KnownEntity): void {
    const last = this.list.pop();
    if (last !== undefined && last !== entry) {
      this.list[entry.index] = last;
      last.index = entry.index;
    }
    this.byId.delete(entry.entity);
    this.free.push(entry);
  }

  /** Forget everything. */
  clear(): void {
    for (const entry of this.list) this.free.push(entry);
    this.list.length = 0;
    this.byId.clear();
  }
}
