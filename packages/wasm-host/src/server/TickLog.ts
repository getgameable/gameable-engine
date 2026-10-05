/**
 * `TickLog` — the entities that appeared and went away during one tick.
 *
 * The replicator sends despawns, and would otherwise have to scan every
 * record to find this tick's spawns. Both lists are owned arrays emptied in
 * place by `rewind()`, so a steady room never allocates for them.
 */
import type { Entity } from '@gameable/sdk';

/**
 * This tick's spawn and despawn ids, in the order they happened.
 *
 * @example
 * ```ts
 * // Internal to `WorldRecord`, which rewinds it in `advance()`:
 * const log = new TickLog();
 * log.spawn(5);
 * log.despawn(5, true); // born this tick: it is in neither list
 * log.rewind();
 * ```
 */
export class TickLog {
  /** Entities spawned this tick and still live. */
  readonly spawned: Entity[] = [];
  /** Entities that existed before this tick and were despawned during it. */
  readonly despawned: Entity[] = [];

  /** Empty both lists for the next tick. */
  rewind(): void {
    this.spawned.length = 0;
    this.despawned.length = 0;
  }

  /** @param entity An entity that just spawned. */
  spawn(entity: Entity): void {
    this.spawned.push(entity);
  }

  /**
   * Log a despawn. An entity spawned this same tick was never seen by a
   * client, so it leaves `spawned` and is not logged as despawned.
   *
   * @param entity The entity that went away.
   * @param bornThisTick Whether its record was made this tick.
   */
  despawn(entity: Entity, bornThisTick: boolean): void {
    if (!bornThisTick) {
      this.despawned.push(entity);
      return;
    }
    const list = this.spawned;
    const at = list.indexOf(entity);
    if (at === -1) return;
    for (let i = at + 1; i < list.length; i += 1) list[i - 1] = list[i];
    list.length -= 1;
  }
}
