/**
 * `defineGame` — the declaration a game module default-exports.
 *
 * The declarative fields (`world`, `player`, `spawns`) are sugar over built-in
 * systems that run in a fixed order before any user system, so two games that
 * declare the same thing behave identically. Anything the declarative layer
 * cannot express is a plain `System`.
 */
import type { FeatureSpec } from './features';
import type { PrefabDef } from './prefab';
import type { Rng } from './rng';
import type { audio } from './audio';
import type { camera } from './camera';
import type { character } from './character';
import type { hud } from './hud';
import type { input } from './input';
import type { physics } from './physics';
import type { DataFacade } from './data';
import type { NetFacade, PlayerHandle, Players, SidedSystem } from './net';
import type { Contact, GameConfig, GameEvent, Quat, Vec3 } from './types';

/**
 * Everything a system can reach.
 *
 * The same object is handed to every system on every frame — it is mutated in
 * place, never rebuilt, so never retain it or destructure `frame` outside the
 * call.
 */
export interface GameContext {
  /** The bitecs world, for `query`, `addComponent` and friends. */
  readonly world: object;
  /** Monotonic fixed-step counter, starting at 0. */
  readonly frame: number;
  /** Fixed timestep in seconds. */
  readonly dt: number;
  /** Simulated seconds since `init`. */
  readonly elapsed: number;
  /** The seeded generator. Never `Math.random`. */
  readonly rng: Rng;
  /** Keyboard, mouse and gamepad. */
  readonly input: typeof input;
  /** Physics queries and body commands. */
  readonly physics: typeof physics;
  /** The camera record for this frame. */
  readonly camera: typeof camera;
  /** The HUD model. */
  readonly hud: typeof hud;
  /** Sound playback. */
  readonly audio: typeof audio;
  /** Splat characters. */
  readonly character: typeof character;
  /** Contacts reported since the previous tick. */
  readonly contacts: readonly Contact[];
  /** Host-side occurrences since the previous tick, in order. */
  readonly events: readonly GameEvent[];
  /**
   * The room's players by id: everyone joined and not yet left, plus anyone
   * whose input is in this step's `frame-input.players`. Empty for a
   * single-player game. Rebuilt only when that set changes, never per tick.
   * Also says who the host is (`host`) and lists the players in id order
   * (`list`), which a system walks without allocating.
   */
  readonly players: Players;
  /** The player this page belongs to, on a client; `null` on the authority and in solo. */
  readonly localPlayer: PlayerHandle | null;
  /** Where this guest runs, game messages in and out, and local-only commands. */
  readonly net: NetFacade;
  /**
   * Player documents and the game's own document in the room's store, and
   * trades between two players. The authority writes; a client's calls do nothing.
   */
  readonly data: DataFacade;
  /**
   * The entity the declarative `player` block spawned in a single-player
   * game, or 0. In a room each player has their own: `playerEntity(id)`.
   */
  readonly player: number;
  /** The `rules` object from `defineGame`, verbatim. */
  readonly rules: Readonly<Record<string, unknown>>;
  /** The `init` config. */
  readonly config: GameConfig;
  /** Instantiate a prefab. */
  spawn(def: PrefabDef, position: Vec3, rotation?: Quat): number;
  /** Destroy an entity and its body. */
  despawn(entity: number): void;
  /** Resolve a manifest string id to a handle, cached. */
  assetId(name: string): number;
  /** The entity `definition.player` spawned for a room player, or 0. */
  playerEntity(id: number): number;
}

/**
 * A system: one plain function, run once per fixed step. In `systems` it may
 * also be a `SidedSystem`, `{ run, on }`, that says where it runs.
 */
export type System = (ctx: GameContext) => void;

/** World-level settings. */
export interface WorldSpec {
  /**
   * Gravity in metres per second squared, applied by the built-in velocity
   * system to entities that have `Velocity` but no `RigidBody`. Bodies get
   * their gravity from the host physics world instead.
   */
  gravity?: number | readonly number[];
  /** Entity ceiling. Sizes every built-in component array. Default 4096. */
  maxEntities?: number;
}

/**
 * Where `definition.player` spawns each seat: one point `[x, y, z]` for
 * everyone, a list of points (seat `i` takes `list[i % list.length]`), or a
 * function of the seat. A single-player game spawns seat 0.
 *
 * The function runs on the authority at the seat's join, inside the step, so
 * it must be deterministic: read only the seat, `ctx.rules`, `ctx.rng` and the
 * world, never the clock or `Math.random`. It runs before `ctx.players` is
 * updated for the step, so read the seat, not `ctx.players`: the map still
 * holds the previous step's players there.
 *
 * @example
 * ```ts
 * import { defineGame, type PlayerSpawn } from 'gameable';
 *
 * const corners: PlayerSpawn = [[-8, 0, -8], [8, 0, -8], [8, 0, 8], [-8, 0, 8]];
 * const ring: PlayerSpawn = (seat) => ({ x: Math.cos(seat) * 6, y: 0, z: Math.sin(seat) * 6 });
 * export default defineGame({ player: { prefab: Hero, spawn: corners } });
 * ```
 */
export type PlayerSpawn =
  readonly number[] | readonly (readonly number[])[] | ((seat: number, ctx: GameContext) => Vec3);

/** The declarative player block. */
export interface PlayerSpec {
  /** Prefab to spawn for the player. */
  prefab?: PrefabDef;
  /** Where each seat spawns; see {@link PlayerSpawn}. Default `[0, 0, 0]`. */
  spawn?: PlayerSpawn;
  /** Which built-in camera rig to drive. */
  camera?: 'firstPerson' | 'thirdPerson';
  /** First-person eye height, metres. Default 1.7. */
  eyeHeight?: number;
  /** Third-person boom length, metres. Default 4. */
  distance?: number;
  /** Third-person height offset, metres. Default 1.6. */
  height?: number;
  /** Radians of look per pixel of mouse movement. Default 0.0025. */
  sensitivity?: number;
}

/** One entry of the declarative `spawns` list. */
export interface SpawnSpec {
  /** What to spawn. */
  prefab: PrefabDef;
  /** Where, `[x, y, z]`. */
  position: readonly number[];
  /** Rotation, `[x, y, z, w]`. Defaults to identity. */
  rotation?: readonly number[];
}

/** Everything a game declares. */
export interface GameSpec {
  /** Manifest string ids to resolve during `init` and cache. */
  assets?: readonly string[];
  /** Optional engine modules this game needs. See `featuresOf`. */
  features?: FeatureSpec;
  /** World settings. */
  world?: WorldSpec;
  /**
   * The player and its camera. Spawned once at `init` in a single-player
   * game; on the authority of a room, once per joined player instead.
   */
  player?: PlayerSpec;
  /** Entities to create during `init`. */
  spawns?: readonly SpawnSpec[];
  /** Arbitrary tuning values, handed back as `ctx.rules`. */
  rules?: Record<string, unknown>;
  /**
   * User systems, run in order after the built-ins. A bare function runs on
   * the authority once `features.multiplayer` is declared, everywhere
   * otherwise; `{ run, on }` says where explicitly.
   */
  systems?: readonly (System | SidedSystem)[];
  /** Extra setup, run after the declarative spawns. */
  init?: (ctx: GameContext) => void;
  /** Convenience: one more system, run after `systems`. */
  update?: (ctx: GameContext) => void;
  /** Called once before the guest is torn down. */
  shutdown?: (ctx: GameContext) => void;
  /** Extra state to fold into `snapshot()`. Must be JSON-serialisable. */
  snapshot?: () => unknown;
  /** Read back what `snapshot` returned. */
  restore?: (state: unknown) => void;
}

/** A validated game declaration. */
export type GameDefinition = Readonly<GameSpec>;

/**
 * Declare a game.
 *
 * @param spec The declaration.
 * @returns The frozen definition, ready for `createGuest` or a build.
 *
 * @example
 * ```ts
 * import { defineGame, prefab } from 'gameable';
 *
 * const Player = prefab({
 *   body: { shape: 'capsule', dims: [0.3, 0.9], kind: 'character' },
 * });
 *
 * export default defineGame({
 *   assets: ['arena'],
 *   world: { gravity: -9.81 },
 *   player: { prefab: Player, spawn: [0, 1, 0], camera: 'firstPerson' },
 *   systems: [(ctx) => { ctx.hud.set({ frame: ctx.frame }); }],
 * });
 * ```
 */
export function defineGame(spec: GameSpec): GameDefinition {
  return Object.freeze({ ...spec });
}
