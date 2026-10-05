/**
 * `VisualState` — an entity's persistent look: material parameters, facial
 * expression, look-at and clip weights.
 *
 * Unlike a sound or a line, these hold until the guest sends another, so a
 * player who joins late must be told the current value. Each is kept as the
 * latest value only (per material name, per expression space), copied into
 * storage the entity owns, and stamped with the tick it last changed, so the
 * replicator can send what changed since a player last heard. The sub-record
 * is made once at spawn; entries are made the first time a name or space is
 * used and overwritten in place afterwards.
 */
import type { Entity, ExpressionSpace, MaterialValue, Vec3 } from '@gameable/sdk';

import { copyList, copyVec } from './copies';
import { materialEquals, materialSlots, writeMaterial, type MaterialSlots } from './materialValue';
import type { VisualSnapshot } from './types';

/**
 * The latest `set-material-param` for one parameter name.
 *
 * @example
 * ```ts
 * for (const m of record.visual.materials) if (m.serial > lastSent) send(m.name, m.value);
 * ```
 */
export interface MaterialParamRecord {
  /** Uniform name. */
  readonly name: string;
  /** The value, owned by the record (never the guest's object). */
  value: MaterialValue;
  /** The tick this value was last changed. */
  serial: number;
}

/**
 * The latest `set-expression` for one expression space.
 *
 * @example
 * ```ts
 * const face = record.visual.expressions.find((e) => e.space === 'arkit52');
 * ```
 */
export interface ExpressionRecord {
  /** The basis the weights are in. */
  readonly space: ExpressionSpace;
  /** Coefficients, owned by the record. */
  readonly weights: number[];
  /** The tick these weights were last changed. */
  serial: number;
}

/**
 * The latest `look-at`.
 *
 * @example
 * ```ts
 * const look = record.visual.lookAt;
 * if (look !== null && look.target !== undefined) console.log(look.target.y);
 * ```
 */
export interface LookAtRecord {
  /** The point looked at, or `undefined` for none; owned by the record. */
  target: Vec3 | undefined;
  /** Blend weight. */
  weight: number;
  /** The tick this was last changed. */
  serial: number;
}

/**
 * The latest `set-clip-weights`.
 *
 * @example
 * ```ts
 * const blend = record.visual.clipWeights;
 * if (blend !== null) console.log(blend.clips, blend.weights);
 * ```
 */
export interface ClipWeightsRecord {
  /** Clip names, owned by the record. */
  readonly clips: string[];
  /** One weight per clip, owned by the record. */
  readonly weights: number[];
  /** Playback rate. */
  timeScale: number;
  /** The tick this was last changed. */
  serial: number;
}

/**
 * @param a The record's list.
 * @param b The guest's list.
 * @returns True when they hold the same values in the same order.
 */
function sameList<T>(a: readonly T[], b: ArrayLike<T>): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * One entity's persistent visual state. Every setter returns whether anything
 * changed, so the caller bumps the entity's `serial` only then.
 *
 * @example
 * ```ts
 * import { VisualState } from 'gameable/host/server';
 *
 * const visual = new VisualState(5);
 * visual.setLookAt({ x: 0, y: 1, z: 0 }, 1, 3); // true: changed on tick 3
 * visual.setLookAt({ x: 0, y: 1, z: 0 }, 1, 4); // false: the same again
 * console.log(visual.serial); // 3
 * ```
 */
export class VisualState {
  /** The entity this belongs to. */
  readonly entity: Entity;
  /** The tick of the last change to any entry; -1 before the first. */
  serial = -1;
  /** One entry per material parameter name, in first-use order. */
  readonly materials: MaterialParamRecord[] = [];
  /** One entry per expression space, in first-use order. */
  readonly expressions: ExpressionRecord[] = [];
  /** The last `look-at`, or null before the first. */
  lookAt: LookAtRecord | null = null;
  /** The last `set-clip-weights`, or null before the first. */
  clipWeights: ClipWeightsRecord | null = null;

  /** Owned value objects behind each material entry, index for index. */
  private readonly materialOwned: MaterialSlots[] = [];
  /** The vector `lookAt.target` points at when it has one. */
  private lookTarget: Vec3 | null = null;

  /** @param entity The entity this belongs to. */
  constructor(entity: Entity) {
    this.entity = entity;
  }

  /**
   * @param name Uniform name.
   * @param value The guest's value; copied.
   * @param tick The current tick.
   * @returns True when the value changed.
   */
  setMaterialParam(name: string, value: MaterialValue, tick: number): boolean {
    let i = 0;
    while (i < this.materials.length && this.materials[i].name !== name) i += 1;
    if (i === this.materials.length) {
      const owned = materialSlots();
      this.materialOwned.push(owned);
      this.materials.push({ name, value: writeMaterial(owned, value), serial: tick });
      return this.stamp(tick);
    }
    const entry = this.materials[i];
    if (materialEquals(entry.value, value)) return false;
    entry.value = writeMaterial(this.materialOwned[i], value);
    entry.serial = tick;
    return this.stamp(tick);
  }

  /**
   * @param space The basis.
   * @param weights Coefficients; copied.
   * @param tick The current tick.
   * @returns True when the weights changed.
   */
  setExpression(space: ExpressionSpace, weights: ArrayLike<number>, tick: number): boolean {
    let entry: ExpressionRecord | undefined;
    for (let i = 0; i < this.expressions.length; i += 1) {
      if (this.expressions[i].space === space) entry = this.expressions[i];
    }
    if (entry === undefined) {
      entry = { space, weights: [], serial: tick };
      this.expressions.push(entry);
    } else if (sameList(entry.weights, weights)) return false;
    copyList(entry.weights, weights);
    entry.serial = tick;
    return this.stamp(tick);
  }

  /**
   * @param target The point, or `undefined` for none; copied.
   * @param weight Blend weight.
   * @param tick The current tick.
   * @returns True when anything changed.
   */
  setLookAt(target: Vec3 | undefined, weight: number, tick: number): boolean {
    const look = (this.lookAt ??= { target: undefined, weight, serial: -1 });
    const was = look.target;
    const same =
      look.serial !== -1 &&
      look.weight === weight &&
      (target === undefined
        ? was === undefined
        : was !== undefined && was.x === target.x && was.y === target.y && was.z === target.z);
    if (same) return false;
    look.weight = weight;
    look.target =
      target === undefined
        ? undefined
        : copyVec((this.lookTarget ??= { x: 0, y: 0, z: 0 }), target);
    look.serial = tick;
    return this.stamp(tick);
  }

  /**
   * @param clips Clip names; copied.
   * @param weights One weight per clip; copied.
   * @param timeScale Playback rate.
   * @param tick The current tick.
   * @returns True when anything changed.
   */
  setClipWeights(
    clips: readonly string[],
    weights: ArrayLike<number>,
    timeScale: number,
    tick: number,
  ): boolean {
    const blend = (this.clipWeights ??= { clips: [], weights: [], timeScale, serial: -1 });
    if (
      blend.serial !== -1 &&
      blend.timeScale === timeScale &&
      sameList(blend.clips, clips) &&
      sameList(blend.weights, weights)
    ) {
      return false;
    }
    copyList(blend.clips, clips);
    copyList(blend.weights, weights);
    blend.timeScale = timeScale;
    blend.serial = tick;
    return this.stamp(tick);
  }

  /**
   * A plain copy, for a welcome snapshot. Allocates; never call it per tick.
   *
   * @returns The state as JSON-safe data that aliases nothing live.
   */
  snapshot(): VisualSnapshot {
    const look = this.lookAt;
    const blend = this.clipWeights;
    return {
      materials: this.materials.map((m) => ({ name: m.name, value: copyMaterial(m.value) })),
      expressions: this.expressions.map((e) => ({ space: e.space, weights: [...e.weights] })),
      lookAt:
        look === null ? null : { target: look.target && { ...look.target }, weight: look.weight },
      clipWeights:
        blend === null
          ? null
          : { clips: [...blend.clips], weights: [...blend.weights], timeScale: blend.timeScale },
    };
  }

  /**
   * @param tick The tick of a change.
   * @returns Always true, so a setter can `return this.stamp(tick)`.
   */
  private stamp(tick: number): true {
    this.serial = tick;
    return true;
  }
}

/**
 * @param value A material value.
 * @returns A fresh copy of it.
 */
function copyMaterial(value: MaterialValue): MaterialValue {
  switch (value.tag) {
    case 'color':
      return { tag: 'color', val: { ...value.val } };
    case 'vector':
      return { tag: 'vector', val: { ...value.val } };
    default:
      return { ...value };
  }
}
