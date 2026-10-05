/**
 * `Quantizer` — how a transform fits the wire.
 *
 * Positions are whole millimetres in an `i32` (±2,147 km) and rotations
 * smallest-three in one `u32`; scale is not quantised (the rows codec sends it
 * as three `f32`, so a mirrored or very large scale arrives as it was sent):
 * the largest component is dropped and rebuilt from the unit length, its index
 * kept in the top 2 bits and the other three, which can only lie in
 * `[-1/sqrt(2), 1/sqrt(2)]`, stored as 10-bit signed integers in ascending
 * component order (bits 29-20, 19-10, 9-0).
 *
 * The sign is canonicalised so the dropped component is positive: `q` and `-q`
 * are the same rotation and encode to the same word.
 */

/** The largest magnitude of a 10-bit signed lane. */
const LANE_MAX = 511;
/** Lane units per unit of a quaternion component. */
const LANE_SCALE = LANE_MAX / Math.SQRT1_2;
/** The identity rotation's word: w (index 3) dropped, the rest zero. */
const IDENTITY = (3 << 30) >>> 0;

/**
 * Position and rotation quantisation for the rows codec.
 *
 * @example
 * ```ts
 * const quantizer = new Quantizer();
 * const mm = quantizer.position(1.2345); // 1235
 * const word = quantizer.packQuat(0, 0, 0, 1);
 * quantizer.unpackQuat(word, new Float32Array(4), 0);
 * ```
 */
export class Quantizer {
  /**
   * Metres to whole millimetres.
   *
   * @param metres - A position lane.
   * @returns Millimetres clamped to `i32`; 0 for a non-finite value.
   */
  position(metres: number): number {
    if (!Number.isFinite(metres)) return 0;
    const mm = Math.round(metres * 1000);
    return mm < -0x80000000 ? -0x80000000 : mm > 0x7fffffff ? 0x7fffffff : mm;
  }

  /**
   * Millimetres back to metres.
   *
   * @param mm - A position lane off the wire.
   * @returns Metres.
   */
  unposition(mm: number): number {
    return mm / 1000;
  }

  /**
   * A rotation to its smallest-three word. The input is normalised first; a
   * zero-length or non-finite quaternion encodes the identity.
   *
   * Plain rounding of each lane can leave the rebuilt component nearly 2e-3
   * off, so the encoder tries the eight floor/ceil combinations of the three
   * lanes and keeps the one whose worst component, rebuilt one included, is
   * nearest: under 1e-3 for every rotation in a million-sample sweep.
   *
   * @param x - Quaternion x.
   * @param y - Quaternion y.
   * @param z - Quaternion z.
   * @param w - Quaternion w.
   * @returns The unsigned 32-bit word.
   */
  packQuat(x: number, y: number, z: number, w: number): number {
    const length = Math.sqrt(x * x + y * y + z * z + w * w);
    if (!Number.isFinite(length) || length === 0) return IDENTITY;
    let dropped = 3;
    let largest = Math.abs(w);
    if (Math.abs(x) > largest) {
      dropped = 0;
      largest = Math.abs(x);
    }
    if (Math.abs(y) > largest) {
      dropped = 1;
      largest = Math.abs(y);
    }
    if (Math.abs(z) > largest) {
      dropped = 2;
      largest = Math.abs(z);
    }
    const sign = (dropped === 0 ? x : dropped === 1 ? y : dropped === 2 ? z : w) < 0 ? -1 : 1;
    const k = sign / length;
    // The three kept components, in ascending index order, and the dropped one.
    const a = (dropped === 0 ? y : x) * k;
    const b = (dropped <= 1 ? z : y) * k;
    const c = (dropped <= 2 ? w : z) * k;
    const d = largest / length;
    const fa = Math.floor(a * LANE_SCALE);
    const fb = Math.floor(b * LANE_SCALE);
    const fc = Math.floor(c * LANE_SCALE);
    let best = Infinity;
    let word = IDENTITY;
    for (let m = 0; m < 8; m += 1) {
      const la = clampLane(fa + (m & 1));
      const lb = clampLane(fb + ((m >> 1) & 1));
      const lc = clampLane(fc + ((m >> 2) & 1));
      const qa = la / LANE_SCALE;
      const qb = lb / LANE_SCALE;
      const qc = lc / LANE_SCALE;
      const rebuilt = Math.sqrt(Math.max(0, 1 - qa * qa - qb * qb - qc * qc));
      const error = Math.max(
        Math.abs(qa - a),
        Math.abs(qb - b),
        Math.abs(qc - c),
        Math.abs(rebuilt - d),
      );
      if (error < best) {
        best = error;
        word = ((dropped << 30) | ((la & 0x3ff) << 20) | ((lb & 0x3ff) << 10) | (lc & 0x3ff)) >>> 0;
      }
    }
    return word;
  }

  /**
   * A smallest-three word back to `out[offset..offset+3]` as xyzw. Any 32-bit
   * word decodes to a unit quaternion, hostile ones included.
   *
   * @param packed - The word off the wire.
   * @param out - Receives x, y, z, w.
   * @param offset - Where x goes in `out`.
   */
  unpackQuat(packed: number, out: Float32Array, offset: number): void {
    const dropped = (packed >>> 30) & 3;
    let a = ((((packed >>> 20) & 0x3ff) << 22) >> 22) / LANE_SCALE;
    let b = ((((packed >>> 10) & 0x3ff) << 22) >> 22) / LANE_SCALE;
    let c = (((packed & 0x3ff) << 22) >> 22) / LANE_SCALE;
    const sum = a * a + b * b + c * c;
    let d = 0;
    if (sum > 1) {
      // Only a word no encoder wrote: renormalise the three, the dropped one is 0.
      const inv = 1 / Math.sqrt(sum);
      a *= inv;
      b *= inv;
      c *= inv;
    } else {
      d = Math.sqrt(1 - sum);
    }
    out[offset] = dropped === 0 ? d : a;
    out[offset + 1] = dropped === 0 ? a : dropped === 1 ? d : b;
    out[offset + 2] = dropped <= 1 ? b : dropped === 2 ? d : c;
    out[offset + 3] = dropped === 3 ? d : c;
  }
}

/**
 * A lane clamped to the 10-bit signed range the word holds.
 *
 * @param lane - A lane in lane units.
 * @returns The lane in `[-511, 511]`.
 */
function clampLane(lane: number): number {
  return lane < -LANE_MAX ? -LANE_MAX : lane > LANE_MAX ? LANE_MAX : lane;
}

const shared = new Quantizer();

/**
 * Packs a rotation into its smallest-three word; see {@link Quantizer.packQuat}.
 *
 * @param x - Quaternion x.
 * @param y - Quaternion y.
 * @param z - Quaternion z.
 * @param w - Quaternion w.
 * @returns The unsigned 32-bit word.
 *
 * @example
 * ```ts
 * const word = packQuat(0, 0, Math.SQRT1_2, Math.SQRT1_2);
 * ```
 */
export function packQuat(x: number, y: number, z: number, w: number): number {
  return shared.packQuat(x, y, z, w);
}

/**
 * Unpacks a smallest-three word into `out` at `offset`; see {@link Quantizer.unpackQuat}.
 *
 * @param packed - The word off the wire.
 * @param out - Receives x, y, z, w.
 * @param offset - Where x goes in `out`.
 *
 * @example
 * ```ts
 * const q = new Float32Array(4);
 * unpackQuat(packQuat(0, 0, 0, 1), q, 0); // q = [0, 0, 0, 1]
 * ```
 */
export function unpackQuat(packed: number, out: Float32Array, offset: number): void {
  shared.unpackQuat(packed, out, offset);
}
