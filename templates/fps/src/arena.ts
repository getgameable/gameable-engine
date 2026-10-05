/**
 * Where things stand in the arena.
 *
 * These are the spawn points of the placeholder arena, in metres, Y-up, with
 * the origin at the centre of the floor and `yaw` in radians about `+Y`
 * (`0` looks down `-Z`). Every `position` is on the floor: a body's own
 * half-height is added when it spawns.
 *
 * They are plain data rather than an import from
 * `gameable/placeholder` because this module is compiled **into the
 * wasm guest**, and the placeholder package is host code — it resolves asset
 * URLs with `import.meta.url`, which a QuickJS component has no use for.
 * `tests/game.test.ts` asserts this table and the package's own `arenaSpawns`
 * never drift apart, so "the level moved" is a failing test and not a
 * mystery.
 *
 * Change the level by editing this file and `src/assets.json` together.
 */

/** A place to put something, with the direction it faces. */
export interface SpawnPoint {
  /** World position `[x, y, z]` in metres, on the floor. */
  readonly position: readonly [number, number, number];
  /** Yaw in radians about `+Y`; `0` looks down `-Z`. */
  readonly yaw: number;
}

/** The spawn table of the arena in `env.arena`. */
export interface ArenaSpawns {
  /** Minimum and maximum corners of the playable volume. */
  readonly bounds: {
    readonly min: readonly [number, number, number];
    readonly max: readonly [number, number, number];
  };
  /** Where the player starts. */
  readonly player: SpawnPoint;
  /** Where the enemies start. Six of them. */
  readonly enemies: readonly SpawnPoint[];
  /** Where the medkits float. Three of them. */
  readonly pickups: readonly SpawnPoint[];
}

/** The placeholder arena's spawn table. */
export const arenaSpawns: ArenaSpawns = {
  bounds: { min: [-12, 0, -12], max: [12, 3, 12] },
  player: { position: [0, 0, 9], yaw: 0 },
  enemies: [
    { position: [-9.5, 0, -9.5], yaw: -2.3562 },
    { position: [9.5, 0, -9.5], yaw: 2.3562 },
    { position: [-9.5, 0, 9.5], yaw: -0.7854 },
    { position: [9.5, 0, 9.5], yaw: 0.7854 },
    { position: [0, 0, -10.5], yaw: 3.1416 },
    { position: [3, 0, -2], yaw: 2.1588 },
  ],
  pickups: [
    { position: [0, 1, 0], yaw: 0 },
    { position: [-8.5, 1, -8.5], yaw: -2.3562 },
    { position: [8.5, 1, 8.5], yaw: 0.7854 },
  ],
};
