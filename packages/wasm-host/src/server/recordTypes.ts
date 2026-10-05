/**
 * The shapes the server's world record is made of.
 *
 * A record is what a client needs to rebuild an entity, and nothing a
 * renderer owns: no `Object3D`, no material, no interpolation pair. The
 * replicator (phase 3) reads these and turns them back into commands.
 */
import type { AssetId, BodyId, Entity, ExpressionSpace, MaterialValue, Vec3 } from '@gameable/sdk';

import type { VisualState } from './VisualState';

/**
 * The animation a `set-anim` last asked for.
 *
 * @example
 * ```ts
 * const anim = adapter.world.entities.get(5)?.anim;
 * if (anim) console.log(anim.clip, anim.looping, anim.speed);
 * ```
 */
export interface AnimRecord {
  /** Clip name. */
  clip: string;
  /** Whether the clip loops. */
  looping: boolean;
  /** Playback speed multiplier. */
  speed: number;
}

/**
 * The splat character a `spawn-character` attached, and its locomotion state.
 *
 * @example
 * ```ts
 * const character = adapter.world.entities.get(5)?.character;
 * if (character) console.log(character.bundle, character.state);
 * ```
 */
export interface CharacterRecord {
  /** Character bundle asset handle, or 0 when only a state has been set. */
  bundle: AssetId;
  /** Locomotion state name, as `set-character-state` sent it. */
  state: string;
  /** Whether the character stands on something. */
  grounded: boolean;
  /**
   * The velocity the last `set-character-state` gave, owned by the record. A
   * client's animator picks idle, walk or run from it, so it is replicated.
   */
  readonly velocity: Vec3;
}

/**
 * One live entity, as the authority knows it.
 *
 * Allocated at spawn and mutated in place afterwards, so a tick that moves
 * every entity allocates nothing.
 *
 * @example
 * ```ts
 * import { createServerAdapter } from 'gameable/host/server';
 *
 * const adapter = createServerAdapter(physics);
 * const record = adapter.world.entities.get(5);
 * if (record !== undefined) console.log(record.name, Array.from(record.position));
 * ```
 */
export interface EntityRecord {
  /** The entity id the guest minted. */
  readonly entity: Entity;
  /**
   * True when a `frame-output.local-commands` spawn made it: the authority's
   * own entity, which is never replicated to any player.
   */
  localOnly: boolean;
  /** The renderable asset handle, or `undefined` when it draws nothing. */
  asset: AssetId | undefined;
  /** The parent entity, or `undefined` at the root. */
  parent: Entity | undefined;
  /** Visibility, as the spawn or a later `VISIBLE` transform row set it. */
  visible: boolean;
  /** Debug name, if the guest gave one. */
  name: string | undefined;
  /** Position, three lanes. */
  readonly position: Float32Array;
  /** Rotation quaternion xyzw, four lanes. */
  readonly rotation: Float32Array;
  /** Scale, three lanes. */
  readonly scale: Float32Array;
  /** The last `set-anim`, or null when none was sent. */
  anim: AnimRecord | null;
  /** The character state, or null when the entity is not a character. */
  character: CharacterRecord | null;
  /** The body driving this entity, or `undefined`. */
  body: BodyId | undefined;
  /**
   * Material parameters, expression, look-at and clip weights: the latest of
   * each, kept so a late joiner is told them. Made at spawn; each entry has
   * its own `serial`.
   */
  readonly visual: VisualState;
  /**
   * The latest of the change ticks below and `visual.serial`: the tick of the
   * last change a client can see. A command that sets a field to the value it
   * already has moves no tick. The body id moves none (clients never see it).
   */
  serial: number;
  /**
   * The tick the pose last changed: a position, rotation or scale lane, or a
   * teleport. The row stream keys on this.
   */
  poseSerial: number;
  /** The tick `asset`, `parent` or `visible` last changed. */
  stateSerial: number;
  /** The tick `anim` last changed. */
  animSerial: number;
  /** The tick `character` last changed. */
  characterSerial: number;
  /** The tick this record was made on. A respawn makes a new record. */
  readonly spawnedAt: number;
  /**
   * The tick of the last teleport (`set-body-transform` with `teleport`, or a
   * transform row with `TRANSFORM_FLAGS.TELEPORT`); -1 when never. A client
   * snaps to a pose sent after a teleport instead of interpolating to it.
   */
  teleportedAt: number;
  /**
   * The tick the guest last wrote this entity's rotation; -1 when never. A
   * body row on that same tick moves the position but leaves the rotation, as
   * on the page.
   */
  authoredAt: number;
}

/**
 * {@link VisualState} as plain JSON, for a welcome snapshot.
 *
 * @example
 * ```ts
 * const visual = adapter.world.snapshot().entities[0].visual;
 * for (const m of visual.materials) console.log(m.name, m.value);
 * ```
 */
export interface VisualSnapshot {
  /** The latest value per material parameter name. */
  materials: { name: string; value: MaterialValue }[];
  /** The latest weights per expression space. */
  expressions: { space: ExpressionSpace; weights: number[] }[];
  /** The latest look-at, or null when none was sent. */
  lookAt: { target: Vec3 | undefined; weight: number } | null;
  /** The latest clip weights, or null when none were sent. */
  clipWeights: { clips: string[]; weights: number[]; timeScale: number } | null;
}

/**
 * {@link EntityRecord} as plain JSON: the typed lanes become `number[]`, the
 * visual state a {@link VisualSnapshot}, and the server-only ticks
 * (`spawnedAt`, `teleportedAt`, `authoredAt`) are left out.
 *
 * @example
 * ```ts
 * const entity: EntitySnapshot = adapter.world.snapshot().entities[0];
 * console.log(entity.position); // [1, 2, 3]
 * ```
 */
export interface EntitySnapshot extends Omit<
  EntityRecord,
  | 'position'
  | 'rotation'
  | 'scale'
  | 'entity'
  | 'localOnly'
  | 'visual'
  | 'spawnedAt'
  | 'teleportedAt'
  | 'authoredAt'
  | 'poseSerial'
  | 'stateSerial'
  | 'animSerial'
  | 'characterSerial'
> {
  /** The persistent visual state. */
  visual: VisualSnapshot;
  /** The entity id. */
  entity: Entity;
  /** Position, three numbers. */
  position: number[];
  /** Rotation xyzw, four numbers. */
  rotation: number[];
  /** Scale, three numbers. */
  scale: number[];
}

/**
 * The whole world at one tick, safe to `JSON.stringify` and to keep: nothing
 * in it aliases the live records.
 *
 * @example
 * ```ts
 * const welcome = JSON.stringify(adapter.world.snapshot());
 * ```
 */
export interface WorldSnapshot {
  /** The tick the snapshot was taken on. */
  frame: number;
  /** Every live entity, in spawn order. */
  entities: EntitySnapshot[];
}
