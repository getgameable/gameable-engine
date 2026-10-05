/**
 * `RowList` — the rows of one send, read straight from the world's records.
 */
import type { EntityRecord } from '@gameable/wasm-host/server';

import type { PlayerRowSource, RowSource } from '../../protocol/types.js';

/**
 * A {@link RowSource} over live records: the codec reads each record's own
 * position, rotation and scale arrays, so nothing is copied. Both lists only
 * grow, so a steady room fills them without allocating.
 *
 * @example
 * ```ts
 * import { RowFlag } from 'gameable/net';
 * import { RowList } from 'gameable/net/server';
 *
 * const rows = new RowList();
 * rows.push(record, RowFlag.POSITION | RowFlag.ROTATION);
 * rows.count; // 1
 * ```
 */
export class RowList implements RowSource {
  private readonly records: EntityRecord[] = [];
  private readonly flagList: number[] = [];
  private used = 0;
  /** The receiving player's own body, the frame's trailer; null for none. */
  player: PlayerRowSource | null = null;

  /** @returns How many rows are in this send. */
  get count(): number {
    return this.used;
  }

  /** Empty the list and drop the trailer; the slots are kept. */
  reset(): void {
    this.used = 0;
    this.player = null;
  }

  /**
   * @param record The entity's live record.
   * @param flags Its `RowFlag` bits.
   */
  push(record: EntityRecord, flags: number): void {
    const at = this.used;
    if (at === this.records.length) {
      this.records.push(record);
      this.flagList.push(flags);
    } else {
      this.records[at] = record;
      this.flagList[at] = flags;
    }
    this.used = at + 1;
  }

  /**
   * @param index A row.
   * @returns Its entity id.
   */
  entity(index: number): number {
    return this.records[index].entity;
  }

  /**
   * @param index A row.
   * @returns Its flags.
   */
  flags(index: number): number {
    return this.flagList[index];
  }

  /**
   * @param index A row.
   * @returns The record's own position lanes.
   */
  position(index: number): ArrayLike<number> {
    return this.records[index].position;
  }

  /**
   * @param index A row.
   * @returns The record's own rotation lanes.
   */
  rotation(index: number): ArrayLike<number> {
    return this.records[index].rotation;
  }

  /**
   * @param index A row.
   * @returns The record's own scale lanes.
   */
  scale(index: number): ArrayLike<number> {
    return this.records[index].scale;
  }
}
