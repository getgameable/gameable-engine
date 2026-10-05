/**
 * `definition.player`, spawned once per joined player on the authority, and
 * once for seat 0 in a single-player game.
 */
import { despawn, spawn } from '../prefab';
import type { GameContext, PlayerSpec } from '../defineGame';
import type { PlayerSpawning } from './PlayerTable';
import type { Vec3 } from '../types';

/** Spawns the declared player prefab at the seat's declared spawn point. */
export class PlayerSpawner implements PlayerSpawning {
  /** Reused spawn position, so a join allocates nothing here. */
  private readonly at: Vec3 = { x: 0, y: 0, z: 0 };

  /**
   * @param spec The game's `player` block; nothing spawns without a prefab.
   * @param ctx The context a spawn function is handed.
   */
  constructor(
    private readonly spec: PlayerSpec | undefined,
    private readonly ctx: GameContext,
  ) {}

  /**
   * Spawn the player prefab for one seat: at the single point, at
   * `list[seat % list.length]`, or where the spawn function says.
   *
   * @param seat The seat (player id); 0 in a single-player game.
   * @returns The new entity, or 0 when the game declares no player prefab.
   */
  spawn(seat: number): number {
    const spec = this.spec;
    if (!spec?.prefab) return 0;
    const at = this.at;
    const where = spec.spawn;
    if (typeof where === 'function') {
      const p = where(seat, this.ctx);
      at.x = p.x;
      at.y = p.y;
      at.z = p.z;
    } else {
      const point = isList(where) ? where[seat % where.length] : where;
      at.x = point?.[0] ?? 0;
      at.y = point?.[1] ?? 0;
      at.z = point?.[2] ?? 0;
    }
    return spawn(spec.prefab, at);
  }

  /** @param entity The leaving player's entity. */
  despawn(entity: number): void {
    despawn(entity);
  }
}

/**
 * @param where A `player.spawn` that is not a function.
 * @returns True for a non-empty list of points rather than one point.
 */
function isList(
  where: readonly number[] | readonly (readonly number[])[] | undefined,
): where is readonly (readonly number[])[] {
  return where !== undefined && where.length > 0 && Array.isArray(where[0]);
}
