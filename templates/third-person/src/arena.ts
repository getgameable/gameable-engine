/**
 * Where things stand in the arena.
 *
 * These are the spawn points of the placeholder arena, in metres, Y-up, with
 * the origin at the centre of the floor and `yaw` in radians about `+Y`.
 * **`0` faces `+Z`** — three's own `rotation.y`, and the direction the sample
 * character is modelled looking. Every `position` is on the floor: a body's own
 * half-height is added when it spawns.
 *
 * They are plain data rather than an import from
 * `gameable/placeholder` because this module is compiled **into the
 * wasm guest**, and the placeholder package is host code — it resolves asset
 * URLs with `import.meta.url`, which a QuickJS component has no use for.
 * `tests/game.test.ts` asserts that the hero's start and the arena's bounds
 * still match the pack's own table, and that every prop below is inside those
 * bounds — so "the level moved" is a failing test and not a mystery.
 *
 * Change the level by editing this file and `src/assets.json` together.
 */

/** A place to put something, with the direction it faces. */
export interface SpawnPoint {
  /** World position `[x, y, z]` in metres, on the floor. */
  readonly position: readonly [number, number, number];
  /** Yaw in radians about `+Y`; `0` faces `+Z`. */
  readonly yaw: number;
}

/** The spawn table of the adventure in `env.arena`. */
export interface ArenaSpawns {
  /** Minimum and maximum corners of the playable volume. */
  readonly bounds: {
    readonly min: readonly [number, number, number];
    readonly max: readonly [number, number, number];
  };
  /** Where the hero starts. Its facing is owned by `systems/locomotion.ts`. */
  readonly hero: SpawnPoint;
  /** The two people to talk to. */
  readonly npcs: readonly SpawnPoint[];
  /** The two chests. One holds the key. */
  readonly chests: readonly SpawnPoint[];
  /** The door out. Opening it ends the round. */
  readonly door: SpawnPoint;
}

/** The placeholder arena's spawn table, as this adventure uses it. */
export const arenaSpawns: ArenaSpawns = {
  bounds: { min: [-12, 0, -12], max: [12, 3, 12] },
  // The pack's `player` point: the near edge of the floor, looking in.
  hero: { position: [0, 0, 9], yaw: 0 },
  npcs: [
    // The guide stands a few metres in front of the hero, looking back at it,
    // so the very first thing a player sees is a person facing them.
    { position: [2.5, 0, 4], yaw: -0.4636 },
    // The wanderer, off to one side, watching the middle of the floor.
    { position: [-7, 0, -4], yaw: 1.0517 },
  ],
  chests: [
    // The pack's first and second pickup anchors, on the floor rather than
    // floating: a chest is furniture, not a power-up.
    { position: [0, 0, 0], yaw: 0 },
    { position: [-8.5, 0, -8.5], yaw: -2.3562 },
  ],
  // The far wall, opposite the hero. Closed until the key turns up.
  door: { position: [0, 0, -10.5], yaw: 0 },
};
