/**
 * `BodyTable` — which entity each physics body drives.
 *
 * The same table the page's `createEngineAdapter` keeps: a `Uint32Array`
 * indexed by the body id itself, so the lookup on every body row and every
 * raycast hit is an array read. Slot 0 is never a body, so 0 doubles as "no
 * such body".
 */
import type { BodyId, Entity } from '@gameable/sdk';

import type { WarnSink } from './types';

/**
 * Body-to-entity lookup, fixed at the physics capacity (`maxBodies`): ids 1 to
 * `maxBodies`. Body ids are the guest's choice, so the table never grows: an id
 * past its capacity is refused (one warning), and the caller drops the command. No
 * allocation ever depends on a guest-chosen id.
 *
 * @example
 * ```ts
 * import { BodyTable } from 'gameable/host/server';
 *
 * const table = new BodyTable(1024, console.warn);
 * table.set(11, 5); // true
 * table.set(0xffffffff, 5); // false, warned once
 * console.log(table.entityOf(11)); // 5
 * ```
 */
export class BodyTable {
  private readonly table: Uint32Array;
  private warned = false;
  private readonly warn: WarnSink;

  /**
   * @param capacity Bodies held: ids 1 to `capacity` (the physics world's `maxBodies`;
   *   slot 0 is "no body", so the table is one longer).
   * @param warn Told once, the first time an id does not fit.
   */
  constructor(capacity: number, warn: WarnSink) {
    this.table = new Uint32Array(Math.max(1, capacity) + 1);
    this.warn = warn;
  }

  /** @returns Bodies the table holds: ids 1 to this. */
  get capacity(): number {
    return this.table.length - 1;
  }

  /**
   * The entity a body drives.
   *
   * @param body Body id.
   * @returns The entity, or 0 for an unknown body.
   */
  entityOf(body: BodyId): Entity {
    return body > 0 && body < this.table.length ? this.table[body] : 0;
  }

  /**
   * Record which entity a body drives.
   *
   * @param body Body id minted by the guest.
   * @param entity The entity, or 0 to forget the body.
   * @returns False when `body` is past the capacity and was mapped to an
   *   entity: refused, and the body must not be created.
   */
  set(body: BodyId, entity: Entity): boolean {
    if (body <= 0) return entity === 0;
    if (body >= this.table.length) {
      if (entity === 0) return true;
      this.refuse(body);
      return false;
    }
    this.table[body] = entity;
    return true;
  }

  /** Forget every body. */
  clear(): void {
    this.table.fill(0);
  }

  /**
   * Say once that an id did not fit.
   *
   * @param body The id.
   */
  private refuse(body: BodyId): void {
    if (this.warned) return;
    this.warned = true;
    this.warn(
      `gameable: body id ${String(body)} is past maxBodies (${String(this.capacity)}); ` +
        'the add-body is dropped and that body does not exist. Raise physics({ maxBodies }).',
    );
  }
}
