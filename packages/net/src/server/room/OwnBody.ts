/**
 * `OwnBody` — one player's own body as their rows frame's trailer carries it
 * (Task 8.1): read from the room's post-step body rows when the rows are taken.
 */
import type { EntityRecord } from '@gameable/wasm-host/server';

import { PlayerRowFlag } from '../../protocol/constants.js';
import type { PlayerRowSource } from '../../protocol/types.js';
import type { BodyStates } from './BodyStates.js';

/** The ground-state lane of a body row that means "on walkable ground". */
const ON_GROUND = 1;

/**
 * A reused {@link PlayerRowSource}: {@link OwnBody.fill} rewrites it in
 * place, so taking rows allocates nothing.
 *
 * @example
 * ```ts
 * import { OwnBody } from './OwnBody.js';
 *
 * const own = new OwnBody();
 * const trailer = own.fill(record, bodies, lastRowsTick) ? own : null;
 * ```
 */
export class OwnBody implements PlayerRowSource {
  entity = 0;
  readonly position = new Float32Array(3);
  readonly velocity = new Float32Array(3);
  flags = 0;

  /**
   * @param record The player's entity's record.
   * @param bodies The room's body rows.
   * @param since The tick of the player's last rows: a teleport after it sets `TELEPORT`.
   * @returns False when the entity has no moving body: no trailer.
   */
  fill(record: EntityRecord, bodies: BodyStates, since: number): boolean {
    const body = record.body;
    if (body === undefined) return false;
    const at = bodies.find(body);
    if (at < 0) return false;
    const rows = bodies.rows;
    this.entity = record.entity;
    for (let i = 0; i < 3; i += 1) {
      this.position[i] = rows[at + 1 + i];
      this.velocity[i] = rows[at + 8 + i];
    }
    let flags = rows[at + 14] === ON_GROUND ? PlayerRowFlag.GROUNDED : 0;
    if (record.teleportedAt > since) flags |= PlayerRowFlag.TELEPORT;
    this.flags = flags;
    return true;
  }
}
