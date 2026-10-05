/**
 * `WorldRecord` — the authority's world, as data.
 *
 * The page turns the guest's commands into three.js objects; the server turns
 * them into one `EntityRecord` per entity plus the body table (both kept by
 * `EntityTable`, the base class). Nothing here draws, interpolates or imports
 * three, and a record is allocated only when its entity spawns.
 *
 * Each setter moves only its own change tick (`stateSerial`, `animSerial`,
 * `characterSerial`, the visual entries; `poseSerial` for a teleport) and
 * `serial`, the latest of them. A setter handed the value a record already
 * holds changes nothing: a locomotion machine that sends `set-anim` every
 * step costs a comparison, not a replicated change.
 */
import type { AssetId, Entity, ExpressionSpace, MaterialValue, Vec3 } from '@gameable/sdk';

import { EntityTable } from './EntityTable';

export type { SpawnFlags } from './EntityRecord';

/** `set-anim` speeds closer than this to the recorded one are no change. */
const ANIM_SPEED_TOLERANCE = 1e-3;
/**
 * Metres per second a character's velocity must move, on some axis, to count
 * as a change. A locomotion blend cannot show less, and a guest that sets the
 * state every step with a jittering velocity would otherwise replicate every step.
 */
const VELOCITY_TOLERANCE = 0.05;
export type { WorldRecordOptions } from './EntityTable';

/**
 * Every live entity, which body drives it, and what changed this tick.
 *
 * @example
 * ```ts
 * import { WorldRecord } from 'gameable/host/server';
 *
 * const world = new WorldRecord();
 * world.advance();
 * const at = { x: 0, y: 1, z: 0 };
 * world.spawn(5, 7, at, { x: 0, y: 0, z: 0, w: 1 }, { x: 1, y: 1, z: 1 }, { visible: true });
 * console.log(world.spawned); // [5]
 * console.log(JSON.stringify(world.snapshot()));
 * ```
 */
export class WorldRecord extends EntityTable {
  /**
   * Mark an entity as teleported this tick, so clients snap to its next pose.
   *
   * @param entity Entity id; ignored when not live.
   */
  teleport(entity: Entity): void {
    const record = this.records.get(entity);
    if (record === undefined) return;
    record.teleportedAt = this.tick;
    this.touchPose(record);
  }

  /**
   * Attach or detach an entity's renderable.
   *
   * @param entity Entity id.
   * @param asset Asset handle, or `undefined`.
   */
  setAsset(entity: Entity, asset: AssetId | undefined): void {
    const record = this.records.get(entity);
    if (record === undefined || record.asset === asset) return;
    record.asset = asset;
    this.touchState(record);
  }

  /**
   * Reparent an entity. The record keeps the guest's local transform as sent.
   *
   * @param entity Entity id.
   * @param parent Parent entity, or `undefined` for the root.
   */
  setParent(entity: Entity, parent: Entity | undefined): void {
    const record = this.records.get(entity);
    if (record === undefined || record.parent === parent) return;
    record.parent = parent;
    this.touchState(record);
  }

  /**
   * Record the clip an entity plays; the anim object is made once, then reused.
   *
   * A speed within 1e-3 of the recorded one is no change (games set it from
   * velocity every tick), and the recorded speed is kept; clip and looping
   * compare exactly.
   *
   * @param entity Entity id.
   * @param clip Clip name.
   * @param looping Whether it loops.
   * @param speed Playback speed.
   */
  setAnim(entity: Entity, clip: string, looping: boolean, speed: number): void {
    const record = this.records.get(entity);
    if (record === undefined) return;
    const anim = record.anim;
    if (anim === null) {
      record.anim = { clip, looping, speed };
    } else {
      const sameSpeed = Math.abs(anim.speed - speed) <= ANIM_SPEED_TOLERANCE;
      if (anim.clip === clip && anim.looping === looping && sameSpeed) return;
      anim.clip = clip;
      anim.looping = looping;
      anim.speed = speed;
    }
    this.touchAnim(record);
  }

  /**
   * Make an entity a splat character, idle and grounded.
   *
   * @param entity Entity id.
   * @param bundle Character bundle asset.
   */
  setCharacter(entity: Entity, bundle: AssetId): void {
    this.writeCharacter(entity, bundle, 'idle', true, undefined);
  }

  /**
   * Record a character's locomotion state.
   *
   * @param entity Entity id.
   * @param state State name.
   * @param grounded Whether it stands on something.
   * @param velocity Its velocity; a change past 0.05 m/s on any axis is a change.
   */
  setCharacterState(entity: Entity, state: string, grounded: boolean, velocity?: Vec3): void {
    this.writeCharacter(entity, undefined, state, grounded, velocity);
  }

  /**
   * @param entity Entity id.
   * @param name Uniform name.
   * @param value The latest value; copied.
   */
  setMaterialParam(entity: Entity, name: string, value: MaterialValue): void {
    const record = this.records.get(entity);
    if (record?.visual.setMaterialParam(name, value, this.tick)) this.touchVisual(record);
  }

  /**
   * @param entity Entity id.
   * @param space The basis.
   * @param weights Coefficients; copied.
   */
  setExpression(entity: Entity, space: ExpressionSpace, weights: ArrayLike<number>): void {
    const record = this.records.get(entity);
    if (record?.visual.setExpression(space, weights, this.tick)) this.touchVisual(record);
  }

  /**
   * @param entity Entity id.
   * @param target The point, or `undefined` for none; copied.
   * @param weight Blend weight.
   */
  lookAt(entity: Entity, target: Vec3 | undefined, weight: number): void {
    const record = this.records.get(entity);
    if (record?.visual.setLookAt(target, weight, this.tick)) this.touchVisual(record);
  }

  /**
   * @param entity Entity id.
   * @param clips Clip names; copied.
   * @param weights One weight per clip; copied.
   * @param timeScale Playback rate.
   */
  setClipWeights(
    entity: Entity,
    clips: readonly string[],
    weights: ArrayLike<number>,
    timeScale: number,
  ): void {
    const record = this.records.get(entity);
    if (record?.visual.setClipWeights(clips, weights, timeScale, this.tick))
      this.touchVisual(record);
  }

  /**
   * @param entity Entity id.
   * @param bundle The bundle, or `undefined` to keep the one it has (0 when none).
   * @param state Locomotion state.
   * @param grounded Whether it stands on something.
   * @param velocity Its velocity, or `undefined` for rest (a `spawn-character`).
   */
  private writeCharacter(
    entity: Entity,
    bundle: AssetId | undefined,
    state: string,
    grounded: boolean,
    velocity: Vec3 | undefined,
  ): void {
    const record = this.records.get(entity);
    if (record === undefined) return;
    const vx = velocity?.x ?? 0;
    const vy = velocity?.y ?? 0;
    const vz = velocity?.z ?? 0;
    const c = record.character;
    if (c === null) {
      record.character = { bundle: bundle ?? 0, state, grounded, velocity: { x: vx, y: vy, z: vz } };
    } else {
      const next = bundle ?? c.bundle;
      const v = c.velocity;
      const moved =
        Math.abs(v.x - vx) > VELOCITY_TOLERANCE ||
        Math.abs(v.y - vy) > VELOCITY_TOLERANCE ||
        Math.abs(v.z - vz) > VELOCITY_TOLERANCE;
      if (c.bundle === next && c.state === state && c.grounded === grounded && !moved) return;
      c.bundle = next;
      c.state = state;
      c.grounded = grounded;
      if (moved) {
        v.x = vx;
        v.y = vy;
        v.z = vz;
      }
    }
    this.touchCharacter(record);
  }
}
