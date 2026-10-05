/**
 * retarget — the pure math behind `tools/retarget_locomotion.mjs`.
 *
 * Kept in `src/` rather than in the tool so it is typechecked and unit-tested
 * with the rest of the package; the tool imports this module directly.
 *
 * Quaternion helpers are written out by hand rather than pulled from three, for
 * two reasons: this module must stay importable from a plain node script with no
 * renderer, and the rebind is the one piece of retargeting whose sign
 * conventions are easy to get subtly wrong, so it is worth reading in full.
 */

/**
 * A quaternion as four numbers in `xyzw` order, matching three's memory layout.
 *
 * Typed as a read-only number array rather than a 4-tuple so a scratch
 * `number[]` can be fed straight back in without a cast; every function here
 * reads exactly four components.
 */
export type Quat = readonly number[];

/** Source bone name to target bone name. */
export type BoneNameMap = ReadonlyMap<string, string>;

/** One bone's rest orientation in both skeletons, in MODEL space. */
export interface RestFrames {
  /** Source bone rest rotation, model space. */
  srcRest: Quat;
  /** Source bone's PARENT rest rotation, model space. */
  srcParentRest: Quat;
  /** Target bone rest rotation, model space. */
  dstRest: Quat;
  /** Target bone's PARENT rest rotation, model space. */
  dstParentRest: Quat;
}

/** The identity rotation. */
export const IDENTITY_QUAT: Quat = [0, 0, 0, 1];

/**
 * Hamilton product `a * b`.
 *
 * @param a Left quaternion.
 * @param b Right quaternion.
 * @param out Four-element output, written in place.
 *
 * @returns `out`.
 */
export function quatMultiply(a: Quat, b: Quat, out: number[]): number[] {
  const [ax, ay, az, aw] = a;
  const [bx, by, bz, bw] = b;
  out[0] = aw * bx + ax * bw + ay * bz - az * by;
  out[1] = aw * by - ax * bz + ay * bw + az * bx;
  out[2] = aw * bz + ax * by - ay * bx + az * bw;
  out[3] = aw * bw - ax * bx - ay * by - az * bz;
  return out;
}

/**
 * Conjugate of a unit quaternion, i.e. its inverse.
 *
 * @param q The quaternion; assumed normalised, as every rest rotation is.
 *
 * @returns A new quaternion.
 */
export function quatInvert(q: Quat): Quat {
  return [-q[0], -q[1], -q[2], q[3]];
}

/**
 * Map a track name from the source naming convention to the target's.
 *
 * A track name is `"<node>.<property>"`; only the node half is mapped.
 *
 * @param trackName Source track name, e.g. `mixamorig:LeftArm.quaternion`.
 * @param boneMap Source bone name to target bone name.
 *
 * @returns The mapped track name, or null when the bone has no target.
 */
export function mapTrackName(trackName: string, boneMap: BoneNameMap): string | null {
  const dot = trackName.lastIndexOf('.');
  const node = dot >= 0 ? trackName.substring(0, dot) : trackName;
  const prop = dot >= 0 ? trackName.substring(dot) : '';
  const leaf = node.split('/').pop() ?? node;
  const mapped = boneMap.get(leaf);
  if (mapped === undefined) return null;
  return `${mapped}${prop}`;
}

/**
 * Rebind one local rotation from the source rest frame into the target's.
 *
 * The formula, in model space:
 *
 * ```text
 * q_target_local = inv(P_dst) * P_src * q_source_local * inv(R_src) * R_dst
 * ```
 *
 * where `R` is a bone's rest rotation and `P` its parent's, both in model
 * space. It has the two properties that make a retarget correct:
 *
 *  - identical skeletons are a no-op — `inv(P)·P·q·inv(R)·R = q`;
 *  - a source pose AT REST maps to the TARGET's rest pose, whatever the two
 *    rest poses are, so a retargeted clip starts from the target's own bind
 *    pose rather than injecting the source rig's A-pose/T-pose difference as a
 *    constant offset into every frame.
 *
 * The second property is the whole point: skipping it is why naively renamed
 * Mixamo clips leave a character with permanently drooping shoulders.
 *
 * @param qSource Local rotation from the source clip.
 * @param frames Rest orientations of the bone in both skeletons.
 * @param out Four-element output, written in place.
 *
 * @returns `out`.
 */
export function rebindLocalRotation(qSource: Quat, frames: RestFrames, out: number[]): number[] {
  const lhs: number[] = [0, 0, 0, 1];
  quatMultiply(quatInvert(frames.dstParentRest), frames.srcParentRest, lhs);
  const mid: number[] = [0, 0, 0, 1];
  quatMultiply(lhs, qSource, mid);
  const rhs: number[] = [0, 0, 0, 1];
  quatMultiply(quatInvert(frames.srcRest), frames.dstRest, rhs);
  return quatMultiply(mid, rhs, out);
}

/**
 * Rebind a whole quaternion keyframe track in place.
 *
 * @param values Flat `xyzw` stream, four floats per key; rewritten in place.
 * @param frames Rest orientations of the bone in both skeletons.
 *
 * @returns `values`, for chaining.
 */
export function rebindQuaternionTrack(
  values: Float32Array | number[],
  frames: RestFrames,
): Float32Array | number[] {
  const src: [number, number, number, number] = [0, 0, 0, 1];
  const out: number[] = [0, 0, 0, 1];
  for (let i = 0; i + 3 < values.length; i += 4) {
    src[0] = values[i];
    src[1] = values[i + 1];
    src[2] = values[i + 2];
    src[3] = values[i + 3];
    rebindLocalRotation(src, frames, out);
    values[i] = out[0];
    values[i + 1] = out[1];
    values[i + 2] = out[2];
    values[i + 3] = out[3];
  }
  return values;
}

/**
 * Scale a position track by the hip-height ratio between the two rigs.
 *
 * Root translation is the one track that does not survive a pure rotation
 * rebind: a 1.9 m source actor's pelvis travels further per stride than a 1.6 m
 * target's, so the target would skate. Scaling by `dstHipHeight / srcHipHeight`
 * makes the stride proportional to the legs that take it.
 *
 * @param values Flat `xyz` stream, three floats per key; rewritten in place.
 * @param ratio `dstHipHeight / srcHipHeight`.
 *
 * @returns `values`, for chaining.
 */
export function scalePositionTrack(
  values: Float32Array | number[],
  ratio: number,
): Float32Array | number[] {
  for (let i = 0; i < values.length; i += 1) values[i] *= ratio;
  return values;
}

/**
 * Hip-height ratio between two rigs.
 *
 * @param srcHipHeight Source pelvis height above the floor, in metres.
 * @param dstHipHeight Target pelvis height above the floor, in metres.
 *
 * @returns The ratio, or 1 when either height is missing or zero.
 */
export function hipHeightRatio(srcHipHeight: number, dstHipHeight: number): number {
  if (!Number.isFinite(srcHipHeight) || !Number.isFinite(dstHipHeight)) return 1;
  if (srcHipHeight <= 1e-9 || dstHipHeight <= 1e-9) return 1;
  return dstHipHeight / srcHipHeight;
}

/**
 * Turn a JSON `{ source: target }` table into a {@link BoneNameMap}.
 *
 * @param table Parsed `mixamo_to_mh.json`.
 *
 * @returns The map.
 *
 * @throws {TypeError} When an entry is not a string-to-string pair.
 */
export function boneMapFromJson(table: unknown): BoneNameMap {
  if (typeof table !== 'object' || table === null) {
    throw new TypeError('bone map: expected an object of { sourceBone: targetBone }');
  }
  // The shipped table wraps the pairs in `bones` so it can also carry a
  // `comment` and the canonical `targets` list; a bare object works too.
  const nested = (table as { bones?: unknown }).bones;
  const pairs =
    typeof nested === 'object' && nested !== null ? (nested as Record<string, unknown>) : table;
  const map = new Map<string, string>();
  for (const [key, value] of Object.entries(pairs as Record<string, unknown>)) {
    if (key.startsWith('$') || key === 'comment' || key === 'targets') continue; // doc keys
    if (typeof value !== 'string') {
      throw new TypeError(`bone map: "${key}" must map to a target bone name`);
    }
    map.set(key, value);
  }
  return map;
}
