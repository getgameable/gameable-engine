/**
 * characterState — the per-frame character state the guest sends the animator.
 *
 * This is the boundary type: it crosses the wasm edge, so it is plain data and
 * it is validated. The guest is game code and game code is wrong sometimes; a
 * `velocity` of `[NaN, 0, 0]` that reaches the locomotion blend produces a
 * skeleton full of NaN quaternions and a character that vanishes with no error
 * to explain it. Validating once at the edge is cheaper than finding that.
 */

/** A clip the guest is driving explicitly, bypassing the locomotion blend. */
export interface CharacterClipRequest {
  /** Clip name as registered with `addClip` or `addFaceClip`. */
  name: string;
  /** Blend weight in `[0, 1]`. */
  weight: number;
  /** Seek to this time in seconds before the next update; omit to let it run. */
  time?: number;
}

/** Everything the guest says about a character for one frame. */
export interface CharacterState {
  /**
   * Explicit clip drives. When present, the locomotion blend is bypassed.
   * Names that match a face clip drive the face layer; the rest drive the body.
   */
  clips?: readonly CharacterClipRequest[];
  /**
   * An expression vector. 52 long means ARKit-52 and is composed with blink;
   * `expressionSpace.dim` long means it is already in the bundle's space and is
   * used as-is.
   */
  expression?: Float32Array;
  /** World-space point to look at, or null to release the head. */
  lookAt?: readonly [number, number, number] | null;
  /** World-space velocity in metres per second. */
  velocity: readonly [number, number, number];
  /** Whether the character is on the ground. */
  grounded: boolean;
}

/** A frozen zero velocity, so the idle state shares one buffer. */
const ZERO_VELOCITY: readonly [number, number, number] = Object.freeze([0, 0, 0] as const);

/** A state with nothing driven: standing still, on the ground, looking nowhere. */
export const IDLE_CHARACTER_STATE: CharacterState = Object.freeze({
  lookAt: null,
  velocity: ZERO_VELOCITY,
  grounded: true,
});

/**
 * Read a finite 3-vector.
 *
 * @param value Candidate value.
 * @param field Field name, for the error message.
 *
 * @returns The vector.
 *
 * @throws {TypeError} When it is not three finite numbers.
 */
function readVec3(value: unknown, field: string): [number, number, number] {
  if (!Array.isArray(value) || value.length !== 3) {
    throw new TypeError(`CharacterState.${field} must be a 3-element array`);
  }
  const out: [number, number, number] = [0, 0, 0];
  for (let i = 0; i < 3; i += 1) {
    const n: unknown = value[i];
    if (typeof n !== 'number' || !Number.isFinite(n)) {
      throw new TypeError(`CharacterState.${field}[${String(i)}] must be a finite number`);
    }
    out[i] = n;
  }
  return out;
}

/**
 * Validate an unknown value as a {@link CharacterState}.
 *
 * @param value The candidate, typically decoded from the guest's frame output.
 *
 * @returns A validated state. Array fields are copied; the `expression`
 *   `Float32Array` is NOT copied, because it is the hot path and the guest owns
 *   a stable buffer for it.
 *
 * @throws {TypeError} Describing the first field that is wrong.
 */
export function validateCharacterState(value: unknown): CharacterState {
  if (typeof value !== 'object' || value === null) {
    throw new TypeError('CharacterState must be an object');
  }
  const raw = value as Record<string, unknown>;

  const velocity = readVec3(raw.velocity, 'velocity');

  if (typeof raw.grounded !== 'boolean') {
    throw new TypeError('CharacterState.grounded must be a boolean');
  }

  const state: CharacterState = { velocity, grounded: raw.grounded, lookAt: null };

  if (raw.lookAt !== undefined && raw.lookAt !== null) {
    state.lookAt = readVec3(raw.lookAt, 'lookAt');
  }

  if (raw.clips !== undefined) {
    if (!Array.isArray(raw.clips)) throw new TypeError('CharacterState.clips must be an array');
    state.clips = raw.clips.map((entry, i): CharacterClipRequest => {
      if (typeof entry !== 'object' || entry === null) {
        throw new TypeError(`CharacterState.clips[${String(i)}] must be an object`);
      }
      const c = entry as Record<string, unknown>;
      if (typeof c.name !== 'string' || c.name === '') {
        throw new TypeError(`CharacterState.clips[${String(i)}].name must be a non-empty string`);
      }
      if (typeof c.weight !== 'number' || !Number.isFinite(c.weight)) {
        throw new TypeError(`CharacterState.clips[${String(i)}].weight must be a finite number`);
      }
      const clip: CharacterClipRequest = { name: c.name, weight: c.weight };
      if (c.time !== undefined) {
        if (typeof c.time !== 'number' || !Number.isFinite(c.time)) {
          throw new TypeError(`CharacterState.clips[${String(i)}].time must be a finite number`);
        }
        clip.time = c.time;
      }
      return clip;
    });
  }

  if (raw.expression !== undefined && raw.expression !== null) {
    if (!(raw.expression instanceof Float32Array)) {
      throw new TypeError('CharacterState.expression must be a Float32Array');
    }
    state.expression = raw.expression;
  }

  return state;
}

/**
 * Planar (XZ) speed of a state's velocity.
 *
 * Y is excluded on purpose: a character falling at 9 m/s is not running, and
 * feeding the fall into the locomotion blend makes the legs sprint mid-air.
 *
 * @param state The character state.
 *
 * @returns Ground speed in metres per second.
 */
export function planarSpeed(state: CharacterState): number {
  const [x, , z] = state.velocity;
  return Math.sqrt(x * x + z * z);
}
