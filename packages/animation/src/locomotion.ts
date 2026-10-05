/**
 * locomotion — the speed-matched 1D blend between locomotion clips.
 *
 * There were no locomotion clips in the POC: walk and run were generated
 * server-side per request. The engine needs a local, deterministic fallback, so
 * this is the classic 1D blend space: clips are tagged with the ground speed
 * they were authored at, the character's planar speed picks the bracketing
 * pair, and the two are crossfaded.
 *
 * The part that matters visually is the time scale. Blending a 1.4 m/s walk
 * with a 4.0 m/s run at alpha 0.5 gives a 2.7 m/s pose, but both clips still
 * play at their authored cadence, so the feet skate. Scaling playback by
 * `speed / blendedSpeed` keeps the stride matched to the ground.
 */

/** One retargeted locomotion clip, as `locomotion.json` records it. */
export interface LocomotionClipMeta {
  /** Runtime clip name. */
  name: string;
  /** GLB file name, relative to the index. */
  file: string;
  /** Whether the clip loops. */
  loop: boolean;
  /** Authored ground speed in metres per second; 0 for idle. */
  speed: number;
}

/** The `locomotion.json` index a retarget run emits. */
export interface LocomotionIndex {
  /** The clips, in any order; {@link sortLocomotionClips} orders them. */
  clips: readonly LocomotionClipMeta[];
}

/** The result of a 1D blend, reused across frames so the hot path allocates nothing. */
export interface LocomotionBlend {
  /** Lower-speed clip name, or null when the index is empty. */
  a: string | null;
  /** Higher-speed clip name; equals `a` outside the bracketed range. */
  b: string | null;
  /** Mix from `a` to `b`, in `[0, 1]`. */
  alpha: number;
  /** Playback rate for both clips, so the stride matches the ground speed. */
  timeScale: number;
}

/** The widest the stride may be stretched before it looks wrong. */
const MIN_TIME_SCALE = 0.5;

/** The tightest the stride may be compressed before it looks wrong. */
const MAX_TIME_SCALE = 2;

/**
 * Create an empty blend result to reuse every frame.
 *
 * @returns A zeroed {@link LocomotionBlend}.
 */
export function createLocomotionBlend(): LocomotionBlend {
  return { a: null, b: null, alpha: 0, timeScale: 1 };
}

/**
 * Order an index by authored speed, ascending.
 *
 * @param index The index.
 *
 * @returns A new array, sorted. Sort once at load; never per frame.
 */
export function sortLocomotionClips(index: LocomotionIndex): LocomotionClipMeta[] {
  return [...index.clips].sort((x, y) => x.speed - y.speed);
}

/**
 * Pick and mix the two clips bracketing `speed`.
 *
 * Below the slowest clip and above the fastest one the blend clamps to that
 * clip — an idle at speed 0 and a run at 4 m/s bound the space — and only the
 * time scale keeps changing.
 *
 * @param sorted Clips ordered by ascending speed, from {@link sortLocomotionClips}.
 * @param speed Planar ground speed in metres per second.
 * @param out Result written in place, from {@link createLocomotionBlend}.
 *
 * @returns `out`.
 */
export function blendLocomotion(
  sorted: readonly LocomotionClipMeta[],
  speed: number,
  out: LocomotionBlend,
): LocomotionBlend {
  out.a = null;
  out.b = null;
  out.alpha = 0;
  out.timeScale = 1;
  if (sorted.length === 0) return out;

  const s = speed > 0 ? speed : 0;
  const first = sorted[0];
  const last = sorted[sorted.length - 1];

  if (s <= first.speed || sorted.length === 1) {
    out.a = first.name;
    out.b = first.name;
    out.alpha = 0;
    out.timeScale = timeScaleFor(s, first.speed);
    return out;
  }
  if (s >= last.speed) {
    out.a = last.name;
    out.b = last.name;
    out.alpha = 0;
    out.timeScale = timeScaleFor(s, last.speed);
    return out;
  }

  let lo = sorted[0];
  let hi = sorted[sorted.length - 1];
  for (let i = 0; i < sorted.length - 1; i += 1) {
    if (s >= sorted[i].speed && s <= sorted[i + 1].speed) {
      lo = sorted[i];
      hi = sorted[i + 1];
      break;
    }
  }

  const span = hi.speed - lo.speed;
  const alpha = span > 0 ? (s - lo.speed) / span : 0;
  out.a = lo.name;
  out.b = hi.name;
  out.alpha = alpha;
  // The blended pose already travels at `s` by construction, so the time scale
  // is 1 inside the bracket; it only bites at the clamped ends.
  out.timeScale = 1;
  return out;
}

/**
 * The playback rate that matches a clip's stride to the ground speed.
 *
 * @param speed Actual ground speed.
 * @param clipSpeed The clip's authored speed.
 *
 * @returns A rate in `[0.5, 2]`, or 1 when the clip is an in-place idle.
 */
export function timeScaleFor(speed: number, clipSpeed: number): number {
  if (clipSpeed <= 1e-6) return 1;
  const raw = speed / clipSpeed;
  return Math.max(MIN_TIME_SCALE, Math.min(MAX_TIME_SCALE, raw));
}

/**
 * Write a blend result into the weight / speed maps the base layer applies.
 *
 * @param blend A result from {@link blendLocomotion}.
 * @param weights Cleared and filled with clip name to weight.
 * @param speeds Cleared and filled with clip name to time scale.
 */
export function writeLocomotionWeights(
  blend: LocomotionBlend,
  weights: Map<string, number>,
  speeds: Map<string, number>,
): void {
  weights.clear();
  speeds.clear();
  if (blend.a === null || blend.b === null) return;
  if (blend.a === blend.b) {
    weights.set(blend.a, 1);
    speeds.set(blend.a, blend.timeScale);
    return;
  }
  weights.set(blend.a, 1 - blend.alpha);
  weights.set(blend.b, blend.alpha);
  speeds.set(blend.a, blend.timeScale);
  speeds.set(blend.b, blend.timeScale);
}

/**
 * Validate an unknown value as a {@link LocomotionIndex}.
 *
 * `locomotion.json` is produced by an offline tool and shipped as an asset, so
 * it is untrusted input by the time it reaches the runtime.
 *
 * @param value Parsed JSON.
 *
 * @returns The validated index.
 *
 * @throws {TypeError} When the shape is wrong.
 */
export function validateLocomotionIndex(value: unknown): LocomotionIndex {
  if (typeof value !== 'object' || value === null) {
    throw new TypeError('locomotion index: expected an object');
  }
  const raw = (value as { clips?: unknown }).clips;
  if (!Array.isArray(raw)) throw new TypeError('locomotion index: `clips` must be an array');
  const clips: LocomotionClipMeta[] = raw.map((entry, i) => {
    if (typeof entry !== 'object' || entry === null) {
      throw new TypeError(`locomotion index: clips[${String(i)}] must be an object`);
    }
    const e = entry as Record<string, unknown>;
    if (typeof e.name !== 'string' || e.name === '') {
      throw new TypeError(`locomotion index: clips[${String(i)}].name must be a non-empty string`);
    }
    if (typeof e.file !== 'string' || e.file === '') {
      throw new TypeError(`locomotion index: clips[${String(i)}].file must be a non-empty string`);
    }
    if (typeof e.speed !== 'number' || !Number.isFinite(e.speed) || e.speed < 0) {
      throw new TypeError(`locomotion index: clips[${String(i)}].speed must be a speed in m/s`);
    }
    return { name: e.name, file: e.file, loop: e.loop !== false, speed: e.speed };
  });
  return { clips };
}
