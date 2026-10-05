import { Quaternion } from 'three/webgpu';

/** Sampled local rotations and root positions from any motion service. */
export interface LocomotionTake {
  fps: number;
  root: ArrayLike<number>;
  bones: Readonly<Record<string, ArrayLike<number>>>;
}
/** Explicit search bounds and cadence constraints; units are metres and seconds. */
export interface GaitCycleOptions {
  firstFrame: number;
  lastFrame: number;
  minimumPeriod: number;
  maximumPeriod: number;
  bones: readonly string[];
  hipRatio: number;
  speed: number;
  minimumSourceSpeed?: number;
  minimumDuration?: number;
  maximumDuration?: number;
}

/**
 * Find the least rotational seam error within an authored steady-motion range.
 * Duration matches source displacement, target hip scale and desired travel speed.
 * Offline only: validates input and allocates temporary quaternions.
 *
 * @param take Source sampled motion.
 * @param options Search window and target gait constraints.
 * @returns Inclusive frame bounds, squared angular error and playback duration.
 * @example
 * ```ts
 * const cycle = selectGaitCycle(take, {
 *   firstFrame: 30, lastFrame: 90, minimumPeriod: 20, maximumPeriod: 40,
 *   bones: ['pelvis', 'thigh_l', 'thigh_r'], hipRatio: 1, speed: 1.6,
 * });
 * ```
 */
export function selectGaitCycle(take: LocomotionTake, options: GaitCycleOptions) {
  const o = options;
  const frames = take.root.length / 3;
  if (
    !Number.isInteger(frames) ||
    !Number.isFinite(take.fps) ||
    take.fps <= 0 ||
    !Number.isFinite(o.hipRatio) ||
    o.hipRatio <= 0 ||
    !Number.isFinite(o.speed) ||
    o.speed <= 0 ||
    ![o.firstFrame, o.lastFrame, o.minimumPeriod, o.maximumPeriod].every(Number.isInteger) ||
    o.firstFrame < 0 ||
    o.lastFrame < o.firstFrame ||
    o.minimumPeriod < 1 ||
    o.maximumPeriod < o.minimumPeriod ||
    o.lastFrame + o.maximumPeriod >= frames ||
    o.bones.length === 0
  )
    throw new RangeError('Invalid gait search bounds or timing');
  for (const key of ['minimumSourceSpeed', 'minimumDuration', 'maximumDuration'] as const)
    if (o[key] !== undefined && (!Number.isFinite(o[key]) || o[key] < 0))
      throw new RangeError('Invalid gait constraint');
  for (let i = 0; i < take.root.length; i++)
    if (!Number.isFinite(take.root[i])) throw new RangeError('Non-finite root motion');
  for (const name of o.bones) validateQuaternions(take.bones[name], frames);
  let score = Infinity,
    start = 0,
    end = 0,
    duration = 0;
  const a = new Quaternion(),
    b = new Quaternion();
  for (let first = o.firstFrame; first <= o.lastFrame; first++) {
    for (let period = o.minimumPeriod; period <= o.maximumPeriod; period++) {
      const last = first + period;
      const travelled =
        Math.hypot(
          take.root[last * 3] - take.root[first * 3],
          take.root[last * 3 + 2] - take.root[first * 3 + 2],
        ) * o.hipRatio;
      const seconds = travelled / o.speed;
      if (
        seconds <= 0 ||
        (travelled * take.fps) / period < (o.minimumSourceSpeed ?? 0) ||
        seconds < (o.minimumDuration ?? 0) ||
        seconds > (o.maximumDuration ?? Infinity)
      )
        continue;
      let cost = 0;
      for (const name of o.bones) {
        const values = take.bones[name];
        cost += a.fromArray(values, first * 4).angleTo(b.fromArray(values, last * 4)) ** 2;
      }
      if (cost < score) {
        score = cost;
        start = first;
        end = last;
        duration = seconds;
      }
    }
  }
  if (!Number.isFinite(score)) throw new Error('No steady complete gait cycle found');
  return { score, start, end, duration };
}

/**
 *
 * @param values
 * @param frames
 */
function validateQuaternions(values: ArrayLike<number> | undefined, frames: number): void {
  if (!values || values.length !== frames * 4 || frames < 2 || !Number.isInteger(frames))
    throw new RangeError('Invalid quaternion track length');
  for (let i = 0; i < values.length; i += 4) {
    const norm = Math.hypot(values[i], values[i + 1], values[i + 2], values[i + 3]);
    if (!Number.isFinite(norm) || Math.abs(norm - 1) > 0.01)
      throw new RangeError('Invalid motion quaternion');
  }
}

/**
 * Distribute quaternion seam error over the last samples, in place; q and -q are equivalent.
 *
 * @param values Packed xyzw samples; must contain unit rotations.
 * @param blendFrames Tail samples to correct (at least two); clamped to track length.
 * @returns Nothing.
 * @example
 * ```ts
 * closeQuaternionLoop(rotations, 6);
 * ```
 */
export function closeQuaternionLoop(values: Float32Array, blendFrames = 6): void {
  const count = values.length / 4;
  validateQuaternions(values, count);
  if (!Number.isInteger(blendFrames) || blendFrames < 2)
    throw new RangeError('Invalid blend frame count');
  const length = Math.min(blendFrames, count);
  const correction = new Quaternion()
    .fromArray(values)
    .multiply(new Quaternion().fromArray(values, (count - 1) * 4).invert())
    .normalize();
  const q = new Quaternion(),
    sample = new Quaternion();
  for (let f = count - length; f < count; f++) {
    const blend = (f - (count - length)) / (length - 1);
    q.identity()
      .slerp(correction, blend * blend)
      .multiply(sample.fromArray(values, f * 4))
      .normalize()
      .toArray(values, f * 4);
  }
}

/**
 * Close a packed xyz root-position track without flattening the whole stride.
 *
 * @param values Packed positions, mutated in place.
 * @param blendFrames Tail samples to correct, at least two.
 * @returns Nothing.
 * @example
 * ```ts
 * closePositionLoop(rootPositions);
 * ```
 */
export function closePositionLoop(values: Float32Array, blendFrames = 6): void {
  const count = values.length / 3;
  if (
    !Number.isInteger(count) ||
    count < 2 ||
    !Number.isInteger(blendFrames) ||
    blendFrames < 2 ||
    values.some((v) => !Number.isFinite(v))
  )
    throw new RangeError('Invalid position loop');
  const length = Math.min(count, blendFrames);
  for (let axis = 0; axis < 3; axis++) {
    const correction = values[axis] - values[(count - 1) * 3 + axis];
    for (let f = count - length; f < count; f++) {
      const blend = (f - (count - length)) / (length - 1);
      values[f * 3 + axis] += correction * blend * blend;
    }
  }
}

/**
 * Prepare a stationary root track from target FK foot heights. Optional source foot heights
 * preserve running flight; omitted heights pin foot contact. Physics owns horizontal travel.
 *
 * @param targetFloors Minimum foot/toe world height per frame at the target rest root height.
 * @param restY Target root rest height.
 * @param options Contact pivot height, source scale and optional source running flight.
 * @param options.contactHeight
 * @param options.sourceFloors
 * @param options.hipRatio
 * @param options.flightThreshold
 * @returns Packed xyz positions, with x/z zero.
 * @example
 * ```ts
 * const positions = stationaryRootTrack([0.1, 0.05, 0.1], 0.9, { contactHeight: 0.045 });
 * ```
 */
export function stationaryRootTrack(
  targetFloors: ArrayLike<number>,
  restY: number,
  options: {
    contactHeight?: number;
    sourceFloors?: ArrayLike<number>;
    hipRatio?: number;
    flightThreshold?: number;
  } = {},
): Float32Array {
  const contact = options.contactHeight ?? 0;
  const ratio = options.hipRatio ?? 1;
  const threshold = options.flightThreshold ?? 0;
  const source = options.sourceFloors;
  if (
    targetFloors.length < 2 ||
    ![restY, contact, ratio, threshold].every(Number.isFinite) ||
    ratio <= 0 ||
    threshold < 0 ||
    (source && source.length !== targetFloors.length)
  )
    throw new RangeError('Invalid root preparation');
  let base = Infinity;
  for (let i = 0; i < targetFloors.length; i++) {
    if (!Number.isFinite(targetFloors[i]) || (source && !Number.isFinite(source[i])))
      throw new RangeError('Invalid foot height');
    if (source) base = Math.min(base, source[i]);
  }
  const values = new Float32Array(targetFloors.length * 3);
  for (let i = 0; i < targetFloors.length; i++) {
    const flight = source ? Math.max(0, source[i] - base - threshold) * ratio : 0;
    values[i * 3 + 1] = restY - targetFloors[i] + contact + flight;
  }
  return values;
}
