/**
 * Previous/current transform pairs in flat typed arrays.
 *
 * Simulation runs at a fixed rate; rendering does not. Writing simulation
 * results straight onto `Object3D`s makes motion stutter whenever a frame falls
 * between two fixed steps. So every entity's transform is kept twice — as it
 * was at the end of the previous fixed step, and as it is now — and the renderer
 * is given the blend at `alpha`.
 *
 * Storage is Structure-of-Arrays and grows by doubling. Nothing here allocates
 * during steady-state play, and nothing here does work for an entity that has
 * not moved: every write compares before it stores, `commit` copies only the
 * slots that changed, and `writeInterpolated` returns before touching the
 * object once the object already holds the final value.
 */
import type { Object3D } from 'three/webgpu';

/** Default number of entity slots a new store reserves. */
export const DEFAULT_TRANSFORM_CAPACITY = 256;

/** When two quaternions are this aligned, lerp and normalise instead of slerping. */
const SLERP_LINEAR_THRESHOLD = 0.9995;

/** Previous and current position, rotation and scale for a set of entity ids. */
export class TransformStore {
  /** Slots currently allocated. Entity ids `0 … capacity - 1` are addressable. */
  #capacity: number;

  /** One past the highest slot ever written; the bound for every scan. */
  #highWater = 0;

  /** `1` when the slot has ever been written, `0` otherwise. */
  #used: Uint8Array;

  /**
   * `1` when the current transform differs from the previous one, so the blend
   * is real motion and must be written on every rendered frame.
   */
  #changed: Uint8Array;

  /**
   * `1` when previous and current agree but the object has not yet been given
   * that final value. Cleared by the one write that delivers it.
   */
  #pending: Uint8Array;

  /** Position at the end of the previous fixed step, 3 floats per slot. */
  #prevPosition: Float32Array;

  /** Rotation at the end of the previous fixed step, 4 floats per slot. */
  #prevQuaternion: Float32Array;

  /** Scale at the end of the previous fixed step, 3 floats per slot. */
  #prevScale: Float32Array;

  /** Position as of the latest fixed step, 3 floats per slot. */
  #position: Float32Array;

  /** Rotation as of the latest fixed step, 4 floats per slot. */
  #quaternion: Float32Array;

  /** Scale as of the latest fixed step, 3 floats per slot. */
  #scale: Float32Array;

  /**
   * Build a transform store.
   *
   * @param capacity Slots to reserve up front.
   */
  constructor(capacity: number = DEFAULT_TRANSFORM_CAPACITY) {
    this.#capacity = Math.max(1, capacity);
    this.#used = new Uint8Array(this.#capacity);
    this.#changed = new Uint8Array(this.#capacity);
    this.#pending = new Uint8Array(this.#capacity);
    this.#prevPosition = new Float32Array(this.#capacity * 3);
    this.#prevQuaternion = new Float32Array(this.#capacity * 4);
    this.#prevScale = new Float32Array(this.#capacity * 3);
    this.#position = new Float32Array(this.#capacity * 3);
    this.#quaternion = new Float32Array(this.#capacity * 4);
    this.#scale = new Float32Array(this.#capacity * 3);
    this.#identity(0, this.#capacity);
  }

  /**
   * Slots currently allocated.
   *
   * @returns The number of addressable entity slots.
   */
  get capacity(): number {
    return this.#capacity;
  }

  /**
   * One past the highest slot ever written.
   *
   * @returns The bound `commit` scans to.
   */
  get highWater(): number {
    return this.#highWater;
  }

  /**
   * Whether an entity has ever been written.
   *
   * @param id Entity id.
   * @returns True when the slot holds a transform.
   */
  has(id: number): boolean {
    return id >= 0 && id < this.#capacity && this.#used[id] === 1;
  }

  /**
   * Whether an entity is mid-motion or still owes its object a write.
   *
   * @param id Entity id.
   * @returns True when the next `writeInterpolated` will touch the object.
   */
  isDirty(id: number): boolean {
    return this.has(id) && (this.#changed[id] === 1 || this.#pending[id] === 1);
  }

  /**
   * Grow so that `id` is addressable.
   *
   * Capacity doubles until it fits, so a run of `spawn` calls is amortised O(1).
   *
   * @param id Entity id that must fit.
   */
  ensure(id: number): void {
    // The hot path: an id that already fits, checked with integer ops only.
    if (id >= 0 && id < this.#capacity && (id | 0) === id) return;
    if (id < 0 || !Number.isInteger(id)) {
      throw new RangeError(
        `TransformStore: entity id must be a non-negative integer, got ${String(id)}`,
      );
    }
    let next = this.#capacity;
    while (next <= id) next *= 2;
    const previousCapacity = this.#capacity;

    this.#used = grow(this.#used, next);
    this.#changed = grow(this.#changed, next);
    this.#pending = grow(this.#pending, next);
    this.#prevPosition = growF32(this.#prevPosition, next * 3);
    this.#prevQuaternion = growF32(this.#prevQuaternion, next * 4);
    this.#prevScale = growF32(this.#prevScale, next * 3);
    this.#position = growF32(this.#position, next * 3);
    this.#quaternion = growF32(this.#quaternion, next * 4);
    this.#scale = growF32(this.#scale, next * 3);
    this.#capacity = next;
    this.#identity(previousCapacity, next);
  }

  /**
   * Write the current position of an entity.
   *
   * The first write to a slot also seeds the previous transform, so a freshly
   * spawned entity does not interpolate in from the origin.
   *
   * @param id Entity id.
   * @param x Position x.
   * @param y Position y.
   * @param z Position z.
   */
  setPosition(id: number, x: number, y: number, z: number): void {
    this.ensure(id);
    const p = this.#position;
    const i = id * 3;
    if (p[i] !== x || p[i + 1] !== y || p[i + 2] !== z) {
      p[i] = x;
      p[i + 1] = y;
      p[i + 2] = z;
      this.#changed[id] = 1;
    }
    this.#touch(id);
  }

  /**
   * Write the current rotation of an entity.
   *
   * @param id Entity id.
   * @param x Quaternion x.
   * @param y Quaternion y.
   * @param z Quaternion z.
   * @param w Quaternion w.
   */
  setQuaternion(id: number, x: number, y: number, z: number, w: number): void {
    this.ensure(id);
    const q = this.#quaternion;
    const i = id * 4;
    if (q[i] !== x || q[i + 1] !== y || q[i + 2] !== z || q[i + 3] !== w) {
      q[i] = x;
      q[i + 1] = y;
      q[i + 2] = z;
      q[i + 3] = w;
      this.#changed[id] = 1;
    }
    this.#touch(id);
  }

  /**
   * Write the current scale of an entity.
   *
   * @param id Entity id.
   * @param x Scale x.
   * @param y Scale y.
   * @param z Scale z.
   */
  setScale(id: number, x: number, y: number, z: number): void {
    this.ensure(id);
    const s = this.#scale;
    const i = id * 3;
    if (s[i] !== x || s[i + 1] !== y || s[i + 2] !== z) {
      s[i] = x;
      s[i + 1] = y;
      s[i + 2] = z;
      this.#changed[id] = 1;
    }
    this.#touch(id);
  }

  /**
   * Write a whole transform at once. This is the packed-buffer entry point.
   *
   * @param id Entity id.
   * @param px Position x.
   * @param py Position y.
   * @param pz Position z.
   * @param qx Quaternion x.
   * @param qy Quaternion y.
   * @param qz Quaternion z.
   * @param qw Quaternion w.
   * @param sx Scale x.
   * @param sy Scale y.
   * @param sz Scale z.
   */
  set(
    id: number,
    px: number,
    py: number,
    pz: number,
    qx: number,
    qy: number,
    qz: number,
    qw: number,
    sx: number,
    sy: number,
    sz: number,
  ): void {
    this.ensure(id);
    const p = this.#position;
    const q = this.#quaternion;
    const s = this.#scale;
    const pi = id * 3;
    const qi = id * 4;
    if (
      p[pi] !== px ||
      p[pi + 1] !== py ||
      p[pi + 2] !== pz ||
      q[qi] !== qx ||
      q[qi + 1] !== qy ||
      q[qi + 2] !== qz ||
      q[qi + 3] !== qw ||
      s[pi] !== sx ||
      s[pi + 1] !== sy ||
      s[pi + 2] !== sz
    ) {
      p[pi] = px;
      p[pi + 1] = py;
      p[pi + 2] = pz;
      q[qi] = qx;
      q[qi + 1] = qy;
      q[qi + 2] = qz;
      q[qi + 3] = qw;
      s[pi] = sx;
      s[pi + 1] = sy;
      s[pi + 2] = sz;
      this.#changed[id] = 1;
    }
    this.#touch(id);
  }

  /**
   * Read the current position into `out`.
   *
   * @param id Entity id.
   * @param out A length-3 array to fill.
   * @returns `out`.
   */
  getPosition(id: number, out: Float32Array | number[]): Float32Array | number[] {
    if (id < 0 || id >= this.#capacity) {
      out[0] = 0;
      out[1] = 0;
      out[2] = 0;
      return out;
    }
    const i = id * 3;
    const p = this.#position;
    out[0] = p[i];
    out[1] = p[i + 1];
    out[2] = p[i + 2];
    return out;
  }

  /**
   * Read the current rotation into `out`.
   *
   * @param id Entity id.
   * @param out A length-4 array to fill.
   * @returns `out`.
   */
  getQuaternion(id: number, out: Float32Array | number[]): Float32Array | number[] {
    if (id < 0 || id >= this.#capacity) {
      out[0] = 0;
      out[1] = 0;
      out[2] = 0;
      out[3] = 1;
      return out;
    }
    const i = id * 4;
    const q = this.#quaternion;
    out[0] = q[i];
    out[1] = q[i + 1];
    out[2] = q[i + 2];
    out[3] = q[i + 3];
    return out;
  }

  /**
   * Make the current transform the previous one, for every slot that changed.
   *
   * Call once per fixed step, **before** that step writes new values. Costs a
   * byte per slot to scan plus ten floats per slot that actually moved.
   */
  commit(): void {
    const changed = this.#changed;
    const pending = this.#pending;
    const pp = this.#prevPosition;
    const cp = this.#position;
    const pq = this.#prevQuaternion;
    const cq = this.#quaternion;
    const ps = this.#prevScale;
    const cs = this.#scale;
    const end = this.#highWater;
    for (let id = 0; id < end; id += 1) {
      if (changed[id] === 0) continue;
      const p = id * 3;
      const q = id * 4;
      pp[p] = cp[p];
      pp[p + 1] = cp[p + 1];
      pp[p + 2] = cp[p + 2];
      ps[p] = cs[p];
      ps[p + 1] = cs[p + 1];
      ps[p + 2] = cs[p + 2];
      pq[q] = cq[q];
      pq[q + 1] = cq[q + 1];
      pq[q + 2] = cq[q + 2];
      pq[q + 3] = cq[q + 3];
      changed[id] = 0;
      pending[id] = 1;
    }
  }

  /**
   * Collapse one entity's history, so the next frame does not interpolate.
   *
   * Use after a teleport.
   *
   * @param id Entity id.
   */
  snap(id: number): void {
    this.ensure(id);
    this.#seed(id);
  }

  /**
   * Write the blend of previous and current onto an `Object3D`.
   *
   * Once previous and current agree and the object has received that value,
   * this returns without touching the object — and so without dirtying its
   * world matrix — until the entity moves again.
   *
   * @param id Entity id.
   * @param object Target object; its `position`, `quaternion` and `scale` are written.
   * @param alpha Interpolation factor, normally the loop's `alpha` in `[0, 1)`.
   * @returns True when the entity existed, whether or not the object needed writing.
   */
  writeInterpolated(id: number, object: Object3D, alpha: number): boolean {
    if (!this.has(id)) return false;
    const p = id * 3;
    const q = id * 4;
    const cp = this.#position;
    const cs = this.#scale;
    const cq = this.#quaternion;

    if (this.#changed[id] === 0) {
      if (this.#pending[id] === 0) return true;
      // Settled: previous equals current, deliver it once.
      this.#pending[id] = 0;
      object.position.set(cp[p], cp[p + 1], cp[p + 2]);
      object.scale.set(cs[p], cs[p + 1], cs[p + 2]);
      object.quaternion.set(cq[q], cq[q + 1], cq[q + 2], cq[q + 3]);
      return true;
    }

    const t = alpha < 0 ? 0 : alpha > 1 ? 1 : alpha;
    const pp = this.#prevPosition;
    object.position.set(
      lerp(pp[p], cp[p], t),
      lerp(pp[p + 1], cp[p + 1], t),
      lerp(pp[p + 2], cp[p + 2], t),
    );

    const ps = this.#prevScale;
    object.scale.set(
      lerp(ps[p], cs[p], t),
      lerp(ps[p + 1], cs[p + 1], t),
      lerp(ps[p + 2], cs[p + 2], t),
    );

    slerpInto(this.#prevQuaternion, cq, q, t, object);
    return true;
  }

  /**
   * Forget an entity. Its slot is reset to the identity transform.
   *
   * @param id Entity id.
   */
  clear(id: number): void {
    if (id < 0 || id >= this.#capacity) return;
    this.#used[id] = 0;
    this.#changed[id] = 0;
    this.#pending[id] = 0;
    this.#identity(id, id + 1);
  }

  /**
   * Bookkeeping after any write: raise the high-water mark and seed a fresh slot.
   *
   * @param id Entity id just written.
   */
  #touch(id: number): void {
    if (id >= this.#highWater) this.#highWater = id + 1;
    if (this.#used[id] !== 1) this.#seed(id);
  }

  /**
   * Copy the current transform of one slot over its previous transform.
   *
   * @param id Entity id.
   */
  #seed(id: number): void {
    const p = id * 3;
    const q = id * 4;
    for (let i = 0; i < 3; i += 1) {
      this.#prevPosition[p + i] = this.#position[p + i];
      this.#prevScale[p + i] = this.#scale[p + i];
    }
    for (let i = 0; i < 4; i += 1) this.#prevQuaternion[q + i] = this.#quaternion[q + i];
    this.#used[id] = 1;
    this.#changed[id] = 0;
    this.#pending[id] = 1;
  }

  /**
   * Reset a slot range to the origin, unit scale and identity rotation.
   *
   * @param from First slot, inclusive.
   * @param to Last slot, exclusive.
   */
  #identity(from: number, to: number): void {
    for (let id = from; id < to; id += 1) {
      const p = id * 3;
      const q = id * 4;
      this.#position[p] = 0;
      this.#position[p + 1] = 0;
      this.#position[p + 2] = 0;
      this.#prevPosition[p] = 0;
      this.#prevPosition[p + 1] = 0;
      this.#prevPosition[p + 2] = 0;
      this.#scale[p] = 1;
      this.#scale[p + 1] = 1;
      this.#scale[p + 2] = 1;
      this.#prevScale[p] = 1;
      this.#prevScale[p + 1] = 1;
      this.#prevScale[p + 2] = 1;
      this.#quaternion[q] = 0;
      this.#quaternion[q + 1] = 0;
      this.#quaternion[q + 2] = 0;
      this.#quaternion[q + 3] = 1;
      this.#prevQuaternion[q] = 0;
      this.#prevQuaternion[q + 1] = 0;
      this.#prevQuaternion[q + 2] = 0;
      this.#prevQuaternion[q + 3] = 1;
    }
  }
}

/**
 * Linear interpolation.
 *
 * @param a Value at `t = 0`.
 * @param b Value at `t = 1`.
 * @param t Factor.
 * @returns The blended value.
 */
function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/**
 * Spherically interpolate two quaternions straight onto an object.
 *
 * Written out by hand rather than through `Quaternion.slerpQuaternions` so it
 * can read from the flat arrays without building two temporaries per entity
 * per frame.
 *
 * @param prev Previous-rotation array.
 * @param curr Current-rotation array.
 * @param q Index of the entity's first component.
 * @param t Factor in `[0, 1]`.
 * @param object Object whose `quaternion` is written.
 */
function slerpInto(
  prev: Float32Array,
  curr: Float32Array,
  q: number,
  t: number,
  object: Object3D,
): void {
  const ax = prev[q];
  const ay = prev[q + 1];
  const az = prev[q + 2];
  const aw = prev[q + 3];
  let bx = curr[q];
  let by = curr[q + 1];
  let bz = curr[q + 2];
  let bw = curr[q + 3];

  let cos = ax * bx + ay * by + az * bz + aw * bw;
  // Take the short way round: q and -q are the same rotation.
  if (cos < 0) {
    cos = -cos;
    bx = -bx;
    by = -by;
    bz = -bz;
    bw = -bw;
  }

  let s0: number;
  let s1: number;
  if (cos > SLERP_LINEAR_THRESHOLD) {
    s0 = 1 - t;
    s1 = t;
  } else {
    const theta = Math.acos(cos);
    const sinTheta = Math.sin(theta);
    s0 = Math.sin((1 - t) * theta) / sinTheta;
    s1 = Math.sin(t * theta) / sinTheta;
  }

  let x = s0 * ax + s1 * bx;
  let y = s0 * ay + s1 * by;
  let z = s0 * az + s1 * bz;
  let w = s0 * aw + s1 * bw;
  const length = Math.sqrt(x * x + y * y + z * z + w * w);
  if (length > 0) {
    const inv = 1 / length;
    x *= inv;
    y *= inv;
    z *= inv;
    w *= inv;
  }
  object.quaternion.set(x, y, z, w);
}

/**
 * Copy a `Uint8Array` into a longer one.
 *
 * @param source Existing array.
 * @param length New length.
 * @returns The grown array.
 */
function grow(source: Uint8Array, length: number): Uint8Array {
  const next = new Uint8Array(length);
  next.set(source);
  return next;
}

/**
 * Copy a `Float32Array` into a longer one.
 *
 * @param source Existing array.
 * @param length New length.
 * @returns The grown array.
 */
function growF32(source: Float32Array, length: number): Float32Array {
  const next = new Float32Array(length);
  next.set(source);
  return next;
}
